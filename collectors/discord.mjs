#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { detectRequest } from "./lib/request-detection.mjs";
import { uploadConversationBatches } from "./lib/radar-upload.mjs";

const SEARCH_LIMIT = 100;
const MESSAGES_PER_RECORD = 10;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function apiRoot(mcpUrl) {
  const url = new URL(mcpUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("DISCORD_MCP_URL must use HTTPS or local HTTP");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function discordRequest(root, path, token, fetchImpl, init = {}) {
  const response = await fetchImpl(new URL(path, root), {
    ...init,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Discord archive request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.results)) throw new Error("Discord archive returned an invalid response");
  return payload;
}

async function searchInterval({ root, token, channelId, fromMs, toMs, fetchImpl }) {
  return discordRequest(root, "/api/search", token, fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      channelIds: [channelId],
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      limit: SEARCH_LIMIT,
    }),
  });
}

async function collectChannelMessages({ root, token, channelId, fromMs, toMs, fetchImpl, budget, minWindowMs }) {
  const pending = [{ fromMs, toMs }];
  const messages = new Map();
  const problems = [];

  while (pending.length) {
    if (budget.used >= budget.maximum) {
      problems.push(`Search request cap reached while reading channel ${channelId}`);
      break;
    }
    const interval = pending.pop();
    budget.used += 1;
    const page = await searchInterval({ root, token, channelId, ...interval, fetchImpl });
    for (const message of page.results) if (message?.id) messages.set(String(message.id), message);

    if (page.results.length >= SEARCH_LIMIT) {
      const duration = interval.toMs - interval.fromMs;
      if (duration <= minWindowMs) {
        problems.push(`Channel ${channelId} reached ${SEARCH_LIMIT} messages inside the minimum time window`);
      } else {
        const midpoint = interval.fromMs + Math.floor(duration / 2);
        pending.push({ fromMs: interval.fromMs, toMs: midpoint });
        pending.push({ fromMs: midpoint + 1, toMs: interval.toMs });
      }
    }
  }

  return { messages: [...messages.values()], problems };
}

function normalizeMessage(raw, ownerId, conversationId) {
  const content = typeof raw.content === "string" ? raw.content.slice(0, 100_000) : "";
  const sentAt = new Date(raw.created_at).toISOString();
  return {
    id: `discord:${raw.id}`,
    externalId: String(raw.id),
    sender: String(raw.author_display_name || raw.author_id || "Unknown Discord sender").slice(0, 300),
    senderIsOwner: String(raw.author_id) === ownerId,
    content,
    sentAt,
    contentHash: hash(`${conversationId}|${content}|${raw.edited_at || ""}`),
    deleted: false,
  };
}

function conversationGroups(rawMessages) {
  const groups = new Map();
  for (const message of rawMessages) {
    if (!message?.id || !message?.channel_id || Number.isNaN(Date.parse(message.created_at))) continue;
    const key = message.thread_id
      ? `thread:${message.thread_id}`
      : `channel:${message.channel_id}:${new Date(message.created_at).toISOString().slice(0, 10)}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  return groups;
}

function buildConversations(rawMessages, ownerId) {
  const conversations = [];
  for (const [groupKey, group] of conversationGroups(rawMessages)) {
    group.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const baseExternalId = `${group[0].guild_id || "unknown"}:${groupKey}`;
    const requestMessages = group.map((message) => normalizeMessage(message, ownerId, `discord:${baseExternalId}`));
    const currentRequest = detectRequest(requestMessages, { ownerId, directConversation: false, threadConversation: groupKey.startsWith("thread:") });
    for (let index = 0; index < group.length; index += MESSAGES_PER_RECORD) {
      const segment = group.slice(index, index + MESSAGES_PER_RECORD);
      const first = segment[0];
      const last = segment[segment.length - 1];
      const segmentNumber = Math.floor(index / 100);
      const externalId = `${first.guild_id || "unknown"}:${groupKey}:${segmentNumber}`;
      const conversationId = `discord:${externalId}`;
      const messages = segment.map((message) => normalizeMessage(message, ownerId, conversationId));
      const threadLabel = first.thread_id ? "thread" : new Date(first.created_at).toISOString().slice(0, 10);
      conversations.push({
        id: conversationId,
        source: "discord",
        externalId,
        title: `Discord ${threadLabel} in #${first.channel_name || first.channel_id}`.slice(0, 500),
        location: `#${first.channel_name || first.channel_id}`.slice(0, 500),
        participantNames: Array.from(new Set(messages.map((message) => message.sender))).slice(0, 100),
        permalink: last.discord_url || first.discord_url || undefined,
        updatedAt: messages[messages.length - 1].sentAt,
        messages,
        request: index + MESSAGES_PER_RECORD >= group.length ? currentRequest : null,
      });
    }
  }
  return conversations;
}

export async function collectDiscord({
  mcpUrl,
  token,
  ownerId,
  ownerQuery,
  lookbackDays = 0,
  maxSearchRequests = 0,
  minWindowMinutes = 15,
  fetchImpl = fetch,
}) {
  const root = apiRoot(mcpUrl);
  const usersUrl = new URL("/api/users", root);
  usersUrl.searchParams.set("query", ownerQuery);
  usersUrl.searchParams.set("limit", "100");
  const users = await discordRequest(root, usersUrl.pathname + usersUrl.search, token, fetchImpl);
  const owner = users.results.find((user) => String(user.id) === ownerId && !user.is_bot);
  if (!owner) throw new Error("Discord owner identity could not be verified in the visible archive");

  const channelsPayload = await discordRequest(root, "/api/channels", token, fetchImpl);
  const channels = channelsPayload.results.filter((channel) => channel?.id && !channel.is_archived);
  const fromMs = lookbackDays > 0 ? Date.now() - lookbackDays * 86_400_000 : 0;
  const toMs = Date.now();
  const budget = { used: 0, maximum: maxSearchRequests > 0 ? maxSearchRequests : Number.POSITIVE_INFINITY };
  const rawMessages = new Map();
  const coverageProblems = [];

  for (const channel of channels) {
    try {
      const result = await collectChannelMessages({
        root,
        token,
        channelId: String(channel.id),
        fromMs,
        toMs,
        fetchImpl,
        budget,
        minWindowMs: Math.max(1, minWindowMinutes) * 60_000,
      });
      for (const message of result.messages) rawMessages.set(String(message.id), message);
      coverageProblems.push(...result.problems);
      if (budget.used >= budget.maximum) break;
    } catch (error) {
      coverageProblems.push(`Could not read Discord channel ${channel.id}: ${error.message}`);
    }
  }

  // The archive search API returns only live records. Until it exposes deletion tombstones,
  // Radar cannot remove a message that was deleted after an earlier successful sync.
  coverageProblems.push("Deletion tombstones are not exposed by the Discord archive search API");
  const conversations = buildConversations([...rawMessages.values()], ownerId);
  const newest = [...rawMessages.values()].map((message) => message.created_at).sort().at(-1);
  return {
    profile: {
      userId: ownerId,
      username: String(owner.display_name || owner.username || ownerId),
    },
    conversations,
    nextCursor: newest || undefined,
    coverage: {
      complete: coverageProblems.length === 0,
      detail: `Read ${rawMessages.size} messages across ${channels.length} allowed Discord channels using ${budget.used} bounded searches. ${coverageProblems.join("; ")}`.slice(0, 2_000),
    },
  };
}

async function main() {
  const required = [
    "DISCORD_MCP_URL",
    "DISCORD_MCP_API_KEY",
    "DISCORD_OWNER_USER_ID",
    "DISCORD_OWNER_QUERY",
    "RADAR_URL",
    "RADAR_INGEST_SECRET",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const result = await collectDiscord({
    mcpUrl: process.env.DISCORD_MCP_URL,
    token: process.env.DISCORD_MCP_API_KEY,
    ownerId: process.env.DISCORD_OWNER_USER_ID,
    ownerQuery: process.env.DISCORD_OWNER_QUERY,
    lookbackDays: Number(process.env.DISCORD_LOOKBACK_DAYS || 0),
    maxSearchRequests: Number(process.env.DISCORD_MAX_SEARCH_REQUESTS || 0),
  });
  const uploaded = await uploadConversationBatches({
    radarUrl: process.env.RADAR_URL,
    secret: process.env.RADAR_INGEST_SECRET,
    conversations: result.conversations,
    source: "discord",
    coverage: result.coverage,
    nextCursor: result.nextCursor,
  });
  console.log(JSON.stringify({
    account: result.profile.username,
    collected: result.conversations.length,
    ...uploaded,
    coverage: result.coverage,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
