import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { collectGmail } from "../collectors/gmail.mjs";
import { collectSlack } from "../collectors/slack.mjs";
import { collectDiscord } from "../collectors/discord.mjs";
import { uploadConversationBatches } from "../collectors/lib/radar-upload.mjs";
import { makeKnowledgeBatches, uploadKnowledgeBatches } from "../collectors/lib/knowledge-upload.mjs";
import { detectRequest } from "../collectors/lib/request-detection.mjs";
import { createCollectorProcessRunner, planSourceSync, runSourceSyncCycle, syncIntervalMilliseconds } from "../scripts/lib/source-sync.mjs";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

test("public-channel questions are ignored unless they target or follow up with the owner", () => {
  const unrelated = detectRequest([
    { sender: "Maya", senderIsOwner: false, content: "Can someone confirm the deployment?", sentAt: "2026-08-10T10:00:00.000Z" },
  ], { ownerId: "UOWNER", directConversation: false });
  const mentioned = detectRequest([
    { sender: "Maya", senderIsOwner: false, content: "<@UOWNER> can you confirm the deployment?", sentAt: "2026-08-10T10:00:00.000Z" },
    { sender: "Leo", senderIsOwner: false, content: "The affected build is beta 42.", sentAt: "2026-08-10T10:01:00.000Z" },
  ], { ownerId: "UOWNER", directConversation: false });
  assert.equal(unrelated, null);
  assert.equal(mentioned.signals.directMention, true);
  assert.match(mentioned.summary, /confirm the deployment/);
});

test("source sync planning reports only missing setting names", () => {
  const plan = planSourceSync({
    RADAR_OWNER_EMAIL: "owner@meticuloushome.com",
    RADAR_URL: "http://localhost:3000",
    RADAR_INGEST_SECRET: "private-ingest-secret",
    SLACK_ACCESS_TOKEN: "private-slack-token",
  });
  assert.equal(plan.find((item) => item.id === "slack").enabled, true);
  assert.ok(plan.find((item) => item.id === "gmail").missing.includes("GMAIL_REFRESH_TOKEN"));
  assert.doesNotMatch(JSON.stringify(plan), /private-ingest-secret|private-slack-token/);
});

test("a failed source does not prevent later configured sources from syncing", async () => {
  const environment = {
    RADAR_OWNER_EMAIL: "owner@meticuloushome.com",
    RADAR_URL: "http://localhost:3000",
    RADAR_INGEST_SECRET: "ingest",
    SLACK_ACCESS_TOKEN: "slack",
    GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret",
    GMAIL_REFRESH_TOKEN: "refresh",
  };
  const called = [];
  const results = await runSourceSyncCycle({
    environment,
    requestedSources: ["slack", "gmail"],
    runCollector: async (collector) => {
      called.push(collector.id);
      if (collector.id === "slack") throw new Error("synthetic failure");
    },
  });
  assert.deepEqual(called, ["slack", "gmail"]);
  assert.deepEqual(results.map((result) => result.status), ["failed", "completed"]);
  assert.doesNotMatch(JSON.stringify(results), /synthetic failure/);
});

test("recurring sync interval is bounded", () => {
  assert.equal(syncIntervalMilliseconds({ RADAR_SYNC_INTERVAL_MINUTES: "5" }), 300_000);
  assert.throws(() => syncIntervalMilliseconds({ RADAR_SYNC_INTERVAL_MINUTES: "0" }), /between 1 and 1440/);
});

test("stopping source sync terminates the active collector and prevents another launch", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  let launches = 0;
  const runner = createCollectorProcessRunner({
    cwd: process.cwd(),
    spawnImpl: () => {
      launches += 1;
      return child;
    },
  });
  const running = runner.runCollector({ label: "Synthetic", script: "collectors/synthetic.mjs" });
  runner.stop();
  await assert.rejects(running, /SIGTERM/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(runner.stopping, true);
  await assert.rejects(
    runner.runCollector({ label: "Later", script: "collectors/later.mjs" }),
    /cancelled before launch/,
  );
  assert.equal(launches, 1);
});

test("Gmail verifies identity, groups by thread, and marks Intercom requests", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") return jsonResponse({ access_token: "test-access" });
    if (url.pathname.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@meticuloushome.com", historyId: "h1" });
    if (url.pathname.endsWith("/threads") && url.searchParams.get("q")?.includes("intercom")) return jsonResponse({ threads: [{ id: "t1" }] });
    if (url.pathname.endsWith("/threads")) return jsonResponse({ threads: [] });
    if (url.pathname.endsWith("/threads/t1")) return jsonResponse({
      id: "t1",
      messages: [{
        id: "m1",
        internalDate: "1760000000000",
        snippet: "Can you review this customer blocker today?",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Intercom Support <support@intercom.example>" },
            { name: "Subject", value: "Customer needs recovery" },
          ],
          body: { data: base64Url("Can you review this customer blocker today?") },
        },
      }],
    });
    throw new Error(`Unexpected Gmail mock request: ${url}`);
  };

  const result = await collectGmail({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    expectedEmail: "owner@meticuloushome.com",
    fetchImpl,
  });
  assert.equal(result.profile.email, "owner@meticuloushome.com");
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].source, "intercom");
  assert.equal(result.conversations[0].messages.length, 1);
  assert.equal(result.conversations[0].request.signals.explicitAsk, true);
  assert.equal(result.conversations[0].request.signals.customerImpact, true);
});

test("Gmail exhaustively paginates matching threads, reads referenced bodies, and stores bounded parts", async () => {
  const longThread = Array.from({ length: 101 }, (_, index) => ({
    id: `m${index}`,
    internalDate: String(1760000000000 + index * 1000),
    snippet: `Snippet ${index}`,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Maya <maya@example.com>" },
        { name: "Subject", value: "Complete mailbox history" },
      ],
      body: index === 0 ? { attachmentId: "body-attachment" } : { data: base64Url(index === 100 ? "Can you confirm the final mailbox step?" : `Mailbox message ${index}`) },
    },
  }));
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") return jsonResponse({ access_token: "test-access" });
    if (url.pathname.endsWith("/profile")) return jsonResponse({ emailAddress: "owner@meticuloushome.com", historyId: "h1" });
    if (url.pathname.endsWith("/threads") && url.searchParams.get("q") === "from:intercom") return jsonResponse({ threads: [] });
    if (url.pathname.endsWith("/threads") && !url.searchParams.get("pageToken")) return jsonResponse({ threads: [{ id: "t-long" }], nextPageToken: "page-2" });
    if (url.pathname.endsWith("/threads") && url.searchParams.get("pageToken") === "page-2") return jsonResponse({ threads: [{ id: "t-short" }] });
    if (url.pathname.endsWith("/threads/t-long")) return jsonResponse({ id: "t-long", messages: longThread });
    if (url.pathname.endsWith("/messages/m0/attachments/body-attachment")) return jsonResponse({ data: base64Url("Referenced Gmail body") });
    if (url.pathname.endsWith("/threads/t-short")) return jsonResponse({
      id: "t-short",
      messages: [{
        id: "short-1",
        internalDate: "1761000000000",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: "Leo <leo@example.com>" }, { name: "Subject", value: "Second page" }],
          body: { data: base64Url("Second page mailbox message") },
        },
      }],
    });
    throw new Error(`Unexpected Gmail pagination request: ${url}`);
  };

  const result = await collectGmail({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    expectedEmail: "owner@meticuloushome.com",
    fetchImpl,
  });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.conversations.length, 12);
  assert.equal(result.conversations.reduce((total, conversation) => total + conversation.messages.length, 0), 102);
  assert.equal(result.conversations[0].messages[0].content, "Referenced Gmail body");
  assert.equal(result.conversations[0].messages.length, 10);
  assert.equal(result.conversations[0].request, null);
  assert.equal(result.conversations[10].request.signals.explicitAsk, true);
  assert.match(result.conversations[10].permalink, /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/t-long$/);
});

test("Gmail stops before mailbox reads when identity does not match", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") return jsonResponse({ access_token: "test-access" });
    if (url.pathname.endsWith("/profile")) return jsonResponse({ emailAddress: "wrong@example.com" });
    throw new Error("Mailbox content should not be requested after identity mismatch");
  };
  await assert.rejects(() => collectGmail({ clientId: "c", clientSecret: "s", refreshToken: "r", expectedEmail: "owner@meticuloushome.com", fetchImpl }), /identity mismatch/);
});

test("Slack verifies identity and detects an unanswered DM request", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    const method = url.pathname.split("/").pop();
    if (method === "auth.test") return jsonResponse({ ok: true, user_id: "UOWNER", team_id: "T1", team: "Meticulous" });
    if (method === "users.info") return jsonResponse({ ok: true, user: { profile: { email: "owner@meticuloushome.com" } } });
    if (method === "conversations.list") return jsonResponse({ ok: true, channels: [{ id: "D1", is_im: true, user: "UOTHER" }], response_metadata: { next_cursor: "" } });
    if (method === "conversations.history") return jsonResponse({
      ok: true,
      messages: [
        { ts: "1760000060.000001", user: "UOTHER", text: "Can you confirm this customer blocker today?" },
        { ts: "1760000000.000001", user: "UOWNER", text: "I am checking it." },
      ],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
    throw new Error(`Unexpected Slack mock request: ${url}`);
  };

  const result = await collectSlack({ token: "xoxp-test", expectedEmail: "owner@meticuloushome.com", fetchImpl });
  assert.equal(result.profile.teamId, "T1");
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].request.signals.explicitAsk, true);
  assert.equal(result.conversations[0].request.signals.newerRepliesAfterOwner, true);
  assert.equal(result.coverage.complete, true);
});

test("Slack exhaustively paginates channels and history, then stores bounded parts", async () => {
  const newestPage = Array.from({ length: 100 }, (_, index) => ({
    ts: `${1760000100 + index}.000001`,
    user: "UOTHER",
    text: index === 99 ? "Can you confirm the final recovery step?" : `History message ${index}`,
  }));
  const fetchImpl = async (input) => {
    const url = new URL(input);
    const method = url.pathname.split("/").pop();
    const cursor = url.searchParams.get("cursor") ?? "";
    if (method === "auth.test") return jsonResponse({ ok: true, user_id: "UOWNER", team_id: "T1", team: "Meticulous", url: "https://meticulous.slack.com/" });
    if (method === "users.info") return jsonResponse({ ok: true, user: { profile: { email: "owner@meticuloushome.com" } } });
    if (method === "conversations.list" && !cursor) return jsonResponse({ ok: true, channels: [{ id: "D1", is_im: true, user: "UOTHER" }], response_metadata: { next_cursor: "channels-2" } });
    if (method === "conversations.list" && cursor === "channels-2") return jsonResponse({ ok: true, channels: [{ id: "C2", name: "empty" }], response_metadata: { next_cursor: "" } });
    if (method === "conversations.history" && url.searchParams.get("channel") === "D1" && !cursor) return jsonResponse({ ok: true, messages: newestPage, response_metadata: { next_cursor: "history-2" } });
    if (method === "conversations.history" && url.searchParams.get("channel") === "D1" && cursor === "history-2") return jsonResponse({ ok: true, messages: [{ ts: "1760000000.000001", user: "UOTHER", text: "Oldest history message" }], response_metadata: { next_cursor: "" } });
    if (method === "conversations.history" && url.searchParams.get("channel") === "C2") return jsonResponse({ ok: true, messages: [], response_metadata: { next_cursor: "" } });
    throw new Error(`Unexpected Slack pagination request: ${url}`);
  };

  const result = await collectSlack({ token: "xoxp-test", expectedEmail: "owner@meticuloushome.com", fetchImpl });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.conversations.length, 11);
  assert.equal(result.conversations.reduce((total, conversation) => total + conversation.messages.length, 0), 101);
  assert.equal(result.conversations[0].messages.length, 10);
  assert.equal(result.conversations[0].request, null);
  assert.equal(result.conversations[10].messages.length, 1);
  assert.equal(result.conversations[10].request.signals.explicitAsk, true);
  assert.match(result.conversations[10].permalink, /^https:\/\/meticulous\.slack\.com\/archives\/D1/);
});

test("Slack stops before conversation reads when identity does not match", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    const method = url.pathname.split("/").pop();
    if (method === "auth.test") return jsonResponse({ ok: true, user_id: "UOWNER", team_id: "T1" });
    if (method === "users.info") return jsonResponse({ ok: true, user: { profile: { email: "wrong@example.com" } } });
    throw new Error("Slack content should not be requested after identity mismatch");
  };
  await assert.rejects(() => collectSlack({ token: "xoxp-test", expectedEmail: "owner@meticuloushome.com", fetchImpl }), /identity mismatch/);
});

test("Discord verifies the owner and detects a newer mentioned request", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/users") return jsonResponse({
      count: 1,
      results: [{ id: "UOWNER", username: "alu", display_name: "Alu", is_bot: false }],
    });
    if (url.pathname === "/api/channels") return jsonResponse({
      count: 1,
      results: [{ id: "C1", guild_id: "G1", name: "software", is_archived: false }],
    });
    if (url.pathname === "/api/search") return jsonResponse({
      count: 2,
      results: [
        {
          id: "M2",
          guild_id: "G1",
          channel_id: "C1",
          channel_name: "software",
          thread_id: "T1",
          author_id: "UOTHER",
          author_display_name: "Maya",
          content: "<@UOWNER> can you review this customer blocker today?",
          created_at: "2026-08-10T16:01:00.000Z",
          discord_url: "https://discord.example/channels/G1/C1/M2",
        },
        {
          id: "M1",
          guild_id: "G1",
          channel_id: "C1",
          channel_name: "software",
          thread_id: "T1",
          author_id: "UOWNER",
          author_display_name: "Alu",
          content: "I am checking it.",
          created_at: "2026-08-10T16:00:00.000Z",
          discord_url: "https://discord.example/channels/G1/C1/M1",
        },
      ],
    });
    throw new Error(`Unexpected Discord mock request: ${url}`);
  };

  const result = await collectDiscord({
    mcpUrl: "https://discord.example/mcp",
    token: "test-token",
    ownerId: "UOWNER",
    ownerQuery: "alu",
    lookbackDays: 7,
    fetchImpl,
  });
  assert.equal(result.profile.userId, "UOWNER");
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].messages.length, 2);
  assert.equal(result.conversations[0].request.signals.directMention, true);
  assert.equal(result.conversations[0].request.signals.newerRepliesAfterOwner, true);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.detail, /Deletion tombstones/);
});

test("Discord stops before reading channels when the owner cannot be verified", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/users") return jsonResponse({
      count: 1,
      results: [{ id: "UOTHER", username: "someone", display_name: "Someone", is_bot: false }],
    });
    throw new Error("Discord channel content should not be requested after identity mismatch");
  };
  await assert.rejects(() => collectDiscord({
    mcpUrl: "https://discord.example/mcp",
    token: "test-token",
    ownerId: "UOWNER",
    ownerQuery: "alu",
    fetchImpl,
  }), /identity could not be verified/);
});

test("an empty collector result still records source coverage", async () => {
  let uploaded;
  const fetchImpl = async (_input, init) => {
    uploaded = JSON.parse(String(init.body));
    return jsonResponse({ upsertedConversations: 0, upsertedMessages: 0 });
  };
  const result = await uploadConversationBatches({
    radarUrl: "https://radar.example",
    secret: "test-secret",
    conversations: [],
    source: "discord",
    coverage: { complete: true, detail: "No messages in the selected interval." },
    fetchImpl,
  });
  assert.deepEqual(uploaded.conversations, []);
  assert.equal(uploaded.source, "discord");
  assert.equal(result.uploadedConversations, 0);
});

test("conversation uploads split on encoded byte size before the ingestion limit", async () => {
  const calls = [];
  const conversations = Array.from({ length: 8 }, (_, conversationIndex) => ({
    id: `large-${conversationIndex}`,
    messages: Array.from({ length: 10 }, (_, messageIndex) => ({ id: `${conversationIndex}-${messageIndex}`, content: "x".repeat(90_000) })),
  }));
  const fetchImpl = async (_input, init) => {
    const payload = JSON.parse(String(init.body));
    calls.push({ count: payload.conversations.length, bytes: new TextEncoder().encode(String(init.body)).byteLength });
    return jsonResponse({ upsertedConversations: payload.conversations.length, upsertedMessages: 0 });
  };
  const result = await uploadConversationBatches({
    radarUrl: "https://radar.example",
    secret: "test-secret",
    conversations,
    source: "slack",
    coverage: { complete: true, detail: "Byte batching test." },
    fetchImpl,
  });
  assert.equal(result.uploadedConversations, 8);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.bytes < 8_000_000));
});

test("knowledge uploads split by encoded bytes and attach source coverage only to the final batch", async () => {
  const documents = [
    { id: "one", content: "x".repeat(80) },
    { id: "two", content: "y".repeat(80) },
  ];
  assert.equal(makeKnowledgeBatches(documents, 20, 150).length, 2);
  const payloads = [];
  const result = await uploadKnowledgeBatches({
    radarUrl: "http://localhost:3000",
    secret: "private-secret",
    documents,
    maxBatchBytes: 150,
    sourceSync: {
      id: "obsidian:test",
      source: "obsidian",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:01.000Z",
      documentCount: 2,
      coverage: { complete: true, detail: "complete" },
    },
    fetchImpl: async (_input, init) => {
      payloads.push(JSON.parse(init.body));
      return Response.json({ upserted: 1 }, { status: 202 });
    },
  });
  assert.deepEqual(result, { uploaded: 2, batches: 2 });
  assert.equal(payloads[0].sourceSync, undefined);
  assert.equal(payloads[1].sourceSync.source, "obsidian");
  assert.doesNotMatch(JSON.stringify(payloads), /private-secret/);
});
