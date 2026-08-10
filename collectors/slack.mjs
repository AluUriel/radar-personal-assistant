#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { detectRequest } from "./lib/request-detection.mjs";
import { uploadConversationBatches } from "./lib/radar-upload.mjs";

const SLACK_BASE = "https://slack.com/api/";
const MESSAGES_PER_RECORD = 10;

class SlackRateLimitError extends Error {
  constructor(retryAfter) {
    super(`Slack rate limit reached; retry after ${retryAfter || "the server-defined delay"}`);
    this.retryAfter = retryAfter;
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function slackGet(method, token, fetchImpl, params = {}) {
  const url = new URL(method, SLACK_BASE);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 429) throw new SlackRateLimitError(response.headers.get("retry-after"));
  if (!response.ok) throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack ${method} failed: ${payload.error || "unknown_error"}`);
  return payload;
}

async function slackCursorItems(method, itemKey, token, fetchImpl, params = {}) {
  const items = [];
  let cursor = "";
  do {
    const page = await slackGet(method, token, fetchImpl, { ...params, cursor });
    items.push(...(page[itemKey] ?? []));
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return items;
}

function normalizeMessage(raw, { teamId, channelId, ownerId, sourceConversationId }) {
  const content = raw.text ?? "";
  return {
    id: `slack:${teamId}:${channelId}:${raw.ts}`,
    externalId: raw.ts,
    sender: raw.user ?? raw.username ?? raw.bot_profile?.name ?? "Unknown Slack sender",
    senderIsOwner: raw.user === ownerId,
    content: content.slice(0, 100_000),
    sentAt: new Date(Number(raw.ts) * 1_000).toISOString(),
    contentHash: hash(`${sourceConversationId}|${content}|${raw.edited?.ts ?? ""}`),
    deleted: raw.subtype === "message_deleted",
  };
}

function channelLocation(channel) {
  if (channel.is_im) return `Slack DM · ${channel.user ?? channel.id}`;
  if (channel.is_mpim) return `Slack group DM · ${channel.name ?? channel.id}`;
  return `#${channel.name ?? channel.id}`;
}

function slackPermalink(workspaceUrl, channelId, timestamp) {
  if (!workspaceUrl) return undefined;
  try {
    const base = new URL(workspaceUrl);
    const path = timestamp ? `archives/${channelId}/p${timestamp.replace(".", "")}` : `archives/${channelId}`;
    return new URL(path, base).toString();
  } catch {
    return undefined;
  }
}

function appendConversationParts(conversations, {
  baseId,
  externalId,
  title,
  location,
  permalink,
  messages,
  request,
}) {
  const partCount = Math.ceil(messages.length / MESSAGES_PER_RECORD);
  for (let index = 0; index < partCount; index += 1) {
    const partMessages = messages.slice(index * MESSAGES_PER_RECORD, (index + 1) * MESSAGES_PER_RECORD);
    const suffix = partCount > 1 ? `:part:${index + 1}` : "";
    conversations.push({
      id: `${baseId}${suffix}`,
      source: "slack",
      externalId: `${externalId}${suffix}`,
      title: title.slice(0, 500),
      location,
      participantNames: Array.from(new Set(partMessages.map((message) => message.sender))).slice(0, 100),
      permalink,
      updatedAt: partMessages[partMessages.length - 1].sentAt,
      messages: partMessages,
      request: index === partCount - 1 ? request : null,
    });
  }
}

export async function collectSlack({
  token,
  expectedEmail,
  lookbackDays = 0,
  maxChannels = 0,
  maxThreads = 0,
  fetchImpl = fetch,
}) {
  const auth = await slackGet("auth.test", token, fetchImpl);
  const owner = await slackGet("users.info", token, fetchImpl, { user: auth.user_id });
  const actualEmail = owner.user?.profile?.email ?? "";
  if (!actualEmail || actualEmail.toLowerCase() !== expectedEmail.trim().toLowerCase()) {
    throw new Error(`Slack identity mismatch: expected ${expectedEmail}, received ${actualEmail || "unknown"}`);
  }

  let channels = [];
  let channelListTruncated = false;
  channels = await slackCursorItems("conversations.list", "channels", token, fetchImpl, {
    types: "public_channel,private_channel,mpim,im",
    exclude_archived: true,
    limit: 200,
  });
  if (maxChannels > 0 && channels.length > maxChannels) {
    channels = channels.slice(0, maxChannels);
    channelListTruncated = true;
  }

  const oldest = lookbackDays > 0 ? String((Date.now() - lookbackDays * 86_400_000) / 1_000) : undefined;
  const conversations = [];
  const coverageProblems = [];
  let fetchedThreads = 0;
  let threadListTruncated = false;

  for (const channel of channels) {
    let rawMessages;
    try {
      rawMessages = await slackCursorItems("conversations.history", "messages", token, fetchImpl, { channel: channel.id, oldest, limit: 200 });
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        coverageProblems.push(`Rate limited while reading ${channel.id}; retry-after=${error.retryAfter || "unknown"}`);
        break;
      }
      coverageProblems.push(`Could not read ${channel.id}: ${error.message}`);
      continue;
    }

    const fetchedThreadRoots = new Set();
    for (const root of rawMessages.filter((message) => message.reply_count > 0)) {
      if (maxThreads > 0 && fetchedThreads >= maxThreads) {
        threadListTruncated = true;
        continue;
      }
      try {
        const threadMessages = await slackCursorItems("conversations.replies", "messages", token, fetchImpl, { channel: channel.id, ts: root.ts, limit: 200 });
        fetchedThreads += 1;
        fetchedThreadRoots.add(root.ts);
        const conversationId = `slack:${auth.team_id}:${channel.id}:thread:${root.ts}`;
        const messages = threadMessages.map((message) => normalizeMessage(message, {
          teamId: auth.team_id,
          channelId: channel.id,
          ownerId: auth.user_id,
          sourceConversationId: conversationId,
        })).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
        if (!messages.length) continue;
        appendConversationParts(conversations, {
          baseId: conversationId,
          externalId: `${auth.team_id}:${channel.id}:thread:${root.ts}`,
          title: root.text ?? "Slack thread",
          location: channelLocation(channel),
          permalink: slackPermalink(auth.url, channel.id, root.ts),
          messages,
          request: detectRequest(messages, { ownerId: auth.user_id, directConversation: Boolean(channel.is_im || channel.is_mpim), threadConversation: true }),
        });
      } catch (error) {
        if (error instanceof SlackRateLimitError) {
          coverageProblems.push(`Rate limited while reading thread ${channel.id}:${root.ts}; retry-after=${error.retryAfter || "unknown"}`);
          break;
        }
        coverageProblems.push(`Could not read thread ${channel.id}:${root.ts}: ${error.message}`);
      }
    }

    const mainRaw = rawMessages.filter((message) => !fetchedThreadRoots.has(message.ts));
    const mainId = `slack:${auth.team_id}:${channel.id}:main`;
    const mainMessages = mainRaw.map((message) => normalizeMessage(message, {
      teamId: auth.team_id,
      channelId: channel.id,
      ownerId: auth.user_id,
      sourceConversationId: mainId,
    })).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
    if (mainMessages.length) {
      appendConversationParts(conversations, {
        baseId: mainId,
        externalId: `${auth.team_id}:${channel.id}:main`,
        title: channel.is_im || channel.is_mpim ? channelLocation(channel) : `#${channel.name ?? channel.id}`,
        location: channelLocation(channel),
        permalink: slackPermalink(auth.url, channel.id),
        messages: mainMessages,
        request: detectRequest(mainMessages, { ownerId: auth.user_id, directConversation: Boolean(channel.is_im || channel.is_mpim) }),
      });
    }
  }

  if (channelListTruncated) coverageProblems.push(`Channel enumeration reached the configured cap of ${maxChannels}`);
  if (threadListTruncated) coverageProblems.push(`Thread expansion reached the configured cap of ${maxThreads}`);
  return {
    profile: { email: actualEmail, userId: auth.user_id, teamId: auth.team_id, team: auth.team },
    conversations,
    coverage: {
      complete: coverageProblems.length === 0,
      detail: coverageProblems.length
        ? `Collected ${channels.length} Slack conversations with limits: ${coverageProblems.join("; ")}`.slice(0, 2_000)
        : `Collected all available history for ${channels.length} accessible Slack conversations${lookbackDays > 0 ? ` over the configured ${lookbackDays}-day window` : ""}.`,
    },
  };
}

async function main() {
  const required = ["SLACK_ACCESS_TOKEN", "RADAR_OWNER_EMAIL", "RADAR_URL", "RADAR_INGEST_SECRET"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const result = await collectSlack({
    token: process.env.SLACK_ACCESS_TOKEN,
    expectedEmail: process.env.RADAR_OWNER_EMAIL,
    lookbackDays: Number(process.env.SLACK_LOOKBACK_DAYS || 0),
    maxChannels: Number(process.env.SLACK_MAX_CHANNELS || 0),
    maxThreads: Number(process.env.SLACK_MAX_THREADS || 0),
  });
  const uploaded = await uploadConversationBatches({
    radarUrl: process.env.RADAR_URL,
    secret: process.env.RADAR_INGEST_SECRET,
    conversations: result.conversations,
    source: "slack",
    coverage: result.coverage,
  });
  console.log(JSON.stringify({ account: result.profile.email, team: result.profile.team, collected: result.conversations.length, ...uploaded, coverage: result.coverage }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error.message); process.exit(1); });
