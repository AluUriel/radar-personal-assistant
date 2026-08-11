import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalOAuthManager } from "../scripts/lib/local-oauth.mjs";
import { readLocalSettings, updateLocalSettings } from "../scripts/lib/local-settings.mjs";
import { refreshOAuthAccessTokens } from "../scripts/lib/oauth-refresh.mjs";

const codec = {
  protect(value) { return `test:${Buffer.from(value).toString("base64")}`; },
  unprotect(value) { return Buffer.from(value.slice(5), "base64").toString(); },
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-oauth-"));
  const environment = { RADAR_CONFIG_DIR: directory };
  updateLocalSettings({
    values: {
      RADAR_OWNER_EMAIL: "owner@example.com",
      GMAIL_CLIENT_ID: "google-client",
      SLACK_CLIENT_ID: "slack-client",
    },
    secrets: { GMAIL_CLIENT_SECRET: "google-secret" },
  }, { environment, codec });
  return { directory, environment };
}

test("Google authorization uses PKCE, verifies the owner, and stores only the refresh token", async () => {
  const { directory, environment } = fixture();
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "google-access", refresh_token: "google-refresh" });
    if (url.includes("gmail.googleapis.com")) return Response.json({ emailAddress: "owner@example.com" });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const oauth = createLocalOAuthManager({ environment, codec, fetchImpl, now: () => 1_000 });
    const started = await oauth.start("google");
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    await oauth.complete(`http://127.0.0.1:8790/?code=google-code&state=${authorization.searchParams.get("state")}`);
    const stored = readLocalSettings({ environment, codec });
    assert.equal(stored.secrets.GMAIL_REFRESH_TOKEN, "google-refresh");
    assert.equal(stored.values.GMAIL_CONNECTED_EMAIL, "owner@example.com");
    assert.equal(requests.some((request) => String(request.init.body).includes("code_verifier=")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Slack authorization requests read-only user scopes and verifies the exact owner", async () => {
  const { directory, environment } = fixture();
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("oauth.v2.access")) return Response.json({ ok: true, authed_user: { access_token: "slack-access", refresh_token: "slack-refresh", expires_in: 3600 } });
    if (url.includes("auth.test")) return Response.json({ ok: true, user_id: "U1", team_id: "T1" });
    if (url.includes("users.info")) return Response.json({ ok: true, user: { profile: { email: "owner@example.com" } } });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const oauth = createLocalOAuthManager({ environment, codec, fetchImpl, now: () => 1_000 });
    const started = await oauth.start("slack");
    const authorization = new URL(started.authorizationUrl);
    assert.match(authorization.searchParams.get("user_scope"), /channels:history/);
    assert.equal(authorization.searchParams.get("redirect_uri"), "http://localhost:8790/oauth/slack/callback");
    await oauth.complete(`http://localhost:8790/oauth/slack/callback?code=slack-code&state=${authorization.searchParams.get("state")}`);
    const stored = readLocalSettings({ environment, codec });
    assert.equal(stored.secrets.SLACK_ACCESS_TOKEN, "slack-access");
    assert.equal(stored.secrets.SLACK_REFRESH_TOKEN, "slack-refresh");
    assert.equal(stored.values.SLACK_CONNECTED_EMAIL, "owner@example.com");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Discord dynamically registers the local client and stores OAuth tokens", async () => {
  const { directory, environment } = fixture();
  updateLocalSettings({ values: { RADAR_OWNER_EMAIL: "" } }, { environment, codec });
  let registrations = 0;
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith(".well-known/oauth-authorization-server")) return Response.json({
      authorization_endpoint: "https://discord.example/authorize",
      token_endpoint: "https://discord.example/token",
      registration_endpoint: "https://discord.example/register",
    });
    if (url.endsWith("/register")) { registrations += 1; return Response.json({ client_id: "discord-client" }); }
    if (url.endsWith("/token")) return Response.json({ access_token: "discord-access", refresh_token: "discord-refresh", expires_in: 3600 });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const oauth = createLocalOAuthManager({ environment, codec, fetchImpl, now: () => 1_000 });
    const started = await oauth.start("discord");
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get("resource"), "https://discord-knowledge-mvp-production.up.railway.app/mcp");
    await oauth.complete(`http://127.0.0.1:8790/oauth/discord/callback?code=discord-code&state=${authorization.searchParams.get("state")}`);
    const stored = readLocalSettings({ environment, codec });
    assert.equal(registrations, 1);
    assert.equal(stored.values.DISCORD_OAUTH_CLIENT_ID, "discord-client");
    assert.equal(stored.secrets.DISCORD_MCP_API_KEY, "discord-access");
    assert.equal(stored.secrets.DISCORD_REFRESH_TOKEN, "discord-refresh");
    assert.equal(requests.some((request) => String(request.init.body).includes("resource=https%3A%2F%2Fdiscord-knowledge-mvp-production.up.railway.app%2Fmcp")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Google and Slack still require an owner email before authorization", async () => {
  const { directory, environment } = fixture();
  updateLocalSettings({ values: { RADAR_OWNER_EMAIL: "" } }, { environment, codec });
  try {
    const oauth = createLocalOAuthManager({ environment, codec });
    await assert.rejects(oauth.start("google"), /Save your owner email/);
    await assert.rejects(oauth.start("slack"), /Save your owner email/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rotating Slack and Discord access tokens are refreshed and persisted before collection", async () => {
  const { directory, environment } = fixture();
  updateLocalSettings({
    values: {
      SLACK_ACCESS_TOKEN_EXPIRES_AT: "2026-01-01T00:00:00.000Z",
      DISCORD_ACCESS_TOKEN_EXPIRES_AT: "2026-01-01T00:00:00.000Z",
      DISCORD_OAUTH_CLIENT_ID: "discord-client",
    },
    secrets: { SLACK_REFRESH_TOKEN: "old-slack", DISCORD_REFRESH_TOKEN: "old-discord" },
  }, { environment, codec });
  const fetchImpl = async (input) => String(input).includes("slack.com")
    ? Response.json({ ok: true, access_token: "new-slack-access", refresh_token: "new-slack-refresh", expires_in: 3600 })
    : Response.json({ access_token: "new-discord-access", refresh_token: "new-discord-refresh", expires_in: 3600 });
  try {
    const current = { ...environment, ...readLocalSettings({ environment, codec }).values, ...readLocalSettings({ environment, codec }).secrets };
    const refreshed = await refreshOAuthAccessTokens(current, { fetchImpl, codec, now: () => Date.parse("2026-08-11T00:00:00.000Z") });
    assert.equal(refreshed.SLACK_ACCESS_TOKEN, "new-slack-access");
    assert.equal(refreshed.DISCORD_MCP_API_KEY, "new-discord-access");
    const stored = readLocalSettings({ environment, codec });
    assert.equal(stored.secrets.SLACK_REFRESH_TOKEN, "new-slack-refresh");
    assert.equal(stored.secrets.DISCORD_REFRESH_TOKEN, "new-discord-refresh");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
