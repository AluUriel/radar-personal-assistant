#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { detectRequest } from "./lib/request-detection.mjs";
import { uploadConversationBatches } from "./lib/radar-upload.mjs";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGES_PER_RECORD = 10;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeBase64Url(value = "") {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function header(message, name) {
  return message.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function emailFrom(value) {
  return value.match(/<([^>]+)>/)?.[1]?.trim().toLowerCase() ?? value.trim().toLowerCase();
}

function flattenParts(part) {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(flattenParts)];
}

async function googleAccessToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const body = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: "refresh_token" });
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Google token refresh failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error("Google token refresh did not return an access token");
  return payload.access_token;
}

async function gmailGet(path, accessToken, fetchImpl, params = {}) {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Gmail ${path} failed with HTTP ${response.status}`);
  return response.json();
}

async function bodyFromMessage(message, accessToken, fetchImpl) {
  const parts = flattenParts(message.payload);
  const part = parts.find((item) => item.mimeType === "text/plain" && (item.body?.data || item.body?.attachmentId))
    ?? parts.find((item) => item.mimeType === "text/html" && (item.body?.data || item.body?.attachmentId))
    ?? parts.find((item) => item.body?.data || item.body?.attachmentId);
  if (!part) return "";
  let encoded = part.body?.data ?? "";
  if (!encoded && part.body?.attachmentId) {
    const attachment = await gmailGet(`/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, accessToken, fetchImpl);
    encoded = attachment.data ?? "";
  }
  const decoded = decodeBase64Url(encoded);
  return part.mimeType === "text/html" ? decoded.replace(/<[^>]+>/g, " ") : decoded;
}

function appendGmailParts(conversations, { source, threadId, title, location, participants, messages, request }) {
  const partCount = Math.ceil(messages.length / MESSAGES_PER_RECORD);
  for (let index = 0; index < partCount; index += 1) {
    const partMessages = messages.slice(index * MESSAGES_PER_RECORD, (index + 1) * MESSAGES_PER_RECORD);
    const suffix = partCount > 1 ? `:part:${index + 1}` : "";
    conversations.push({
      id: `${source}:thread:${threadId}${suffix}`,
      source,
      externalId: `${threadId}${suffix}`,
      title: title.slice(0, 500),
      location,
      participantNames: participants,
      permalink: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`,
      updatedAt: partMessages[partMessages.length - 1].sentAt,
      messages: partMessages,
      request: index === partCount - 1 ? request : null,
    });
  }
}

export async function collectGmail({
  clientId,
  clientSecret,
  refreshToken,
  expectedEmail,
  inboxQuery = "in:anywhere -in:spam -in:trash",
  intercomQuery = "from:intercom",
  maxThreads = 0,
  fetchImpl = fetch,
}) {
  const accessToken = await googleAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
  const profile = await gmailGet("/profile", accessToken, fetchImpl);
  if (!profile.emailAddress || profile.emailAddress.toLowerCase() !== expectedEmail.trim().toLowerCase()) {
    throw new Error(`Gmail identity mismatch: expected ${expectedEmail}, received ${profile.emailAddress || "unknown"}`);
  }

  const threadSources = new Map();
  let truncated = false;
  for (const [source, query] of [["intercom", intercomQuery], ["gmail", inboxQuery]]) {
    let pageToken = "";
    do {
      const remaining = maxThreads > 0 ? Math.max(1, maxThreads - threadSources.size) : 500;
      const page = await gmailGet("/threads", accessToken, fetchImpl, { q: query, maxResults: Math.min(500, remaining), pageToken });
      for (const thread of page.threads ?? []) {
        if (!threadSources.has(thread.id)) threadSources.set(thread.id, source);
        if (maxThreads > 0 && threadSources.size >= maxThreads) {
          truncated = Boolean(page.nextPageToken) || (page.threads ?? []).length > 0;
          break;
        }
      }
      pageToken = maxThreads > 0 && threadSources.size >= maxThreads ? "" : (page.nextPageToken ?? "");
    } while (pageToken);
  }

  const conversations = [];
  for (const [threadId, source] of threadSources) {
    const thread = await gmailGet(`/threads/${encodeURIComponent(threadId)}`, accessToken, fetchImpl, { format: "full" });
    const rawMessages = thread.messages ?? [];
    const normalizedMessages = (await Promise.all(rawMessages.map(async (message) => {
      const from = header(message, "From");
      const content = (await bodyFromMessage(message, accessToken, fetchImpl)).trim() || message.snippet || "";
      const sentAt = new Date(Number(message.internalDate || Date.now())).toISOString();
      return {
        id: `${source}:${threadId}:${message.id}`,
        externalId: message.id,
        sender: from || "Unknown sender",
        senderIsOwner: emailFrom(from) === expectedEmail.trim().toLowerCase(),
        content: content.slice(0, 100_000),
        sentAt,
        contentHash: hash(content),
        deleted: false,
      };
    }))).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
    if (!normalizedMessages.length) continue;
    const first = rawMessages[0];
    const subject = header(first, "Subject") || "(No subject)";
    appendGmailParts(conversations, {
      source,
      threadId,
      title: subject,
      location: source === "intercom" ? "Gmail · Intercom" : "Gmail · Mailbox",
      participants: Array.from(new Set(rawMessages.map((message) => header(message, "From")).filter(Boolean))).slice(0, 100),
      messages: normalizedMessages,
      request: detectRequest(normalizedMessages, { ownerEmail: expectedEmail, directConversation: true }),
    });
  }

  return {
    profile: { email: profile.emailAddress, historyId: profile.historyId },
    conversations,
    coverage: {
      complete: !truncated,
      detail: truncated
        ? `Collected ${conversations.length} Gmail/Intercom threads; more matching threads remain after the configured cap.`
        : `Collected all ${conversations.length} Gmail/Intercom threads matching the configured queries.`,
    },
  };
}

async function main() {
  const required = ["GMAIL_CLIENT_ID", "GMAIL_REFRESH_TOKEN", "RADAR_OWNER_EMAIL", "RADAR_URL", "RADAR_INGEST_SECRET"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const result = await collectGmail({
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    expectedEmail: process.env.RADAR_OWNER_EMAIL,
    inboxQuery: process.env.GMAIL_QUERY,
    intercomQuery: process.env.INTERCOM_GMAIL_QUERY,
    maxThreads: Number(process.env.GMAIL_MAX_THREADS || 0),
  });
  let uploadedConversations = 0;
  let uploadedMessages = 0;
  for (const source of ["intercom", "gmail"]) {
    const conversations = result.conversations.filter((conversation) => conversation.source === source);
    const uploaded = await uploadConversationBatches({
      radarUrl: process.env.RADAR_URL,
      secret: process.env.RADAR_INGEST_SECRET,
      conversations,
      source,
      coverage: result.coverage,
    });
    uploadedConversations += uploaded.uploadedConversations;
    uploadedMessages += uploaded.uploadedMessages;
  }
  console.log(JSON.stringify({ account: result.profile.email, collected: result.conversations.length, uploadedConversations, uploadedMessages, coverage: result.coverage }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error.message); process.exit(1); });
