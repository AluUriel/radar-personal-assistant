import crypto from "node:crypto";
import { readLocalSettings, updateLocalSettings, windowsDpapiCodec } from "./local-settings.mjs";

const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/gmail.readonly";
const SLACK_SCOPES = [
  "users:read", "users:read.email",
  "channels:read", "channels:history",
  "groups:read", "groups:history",
  "im:read", "im:history",
  "mpim:read", "mpim:history",
];
const DISCORD_ISSUER = "https://discord-knowledge-mvp-production.up.railway.app/";
const FLOW_TTL_MS = 10 * 60 * 1000;

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function pkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function jsonRequest(url, init, fetchImpl) {
  const response = await fetchImpl(url, { ...init, redirect: "error" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const code = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Authorization provider rejected the request: ${code}`);
  }
  return payload;
}

function requireValue(value, message) {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

function exactOwner(expected, actual, provider) {
  if (!actual || actual.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`${provider} account ${actual || "unknown"} does not match the configured owner ${expected}`);
  }
}

function expiresAt(seconds, now) {
  return seconds ? new Date(now() + Number(seconds) * 1_000).toISOString() : "";
}

export function createLocalOAuthManager({
  environment = process.env,
  codec = windowsDpapiCodec,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const flows = new Map();

  function settings() {
    return readLocalSettings({ environment, codec });
  }

  function createFlow(provider, redirectUri) {
    const { verifier, challenge } = pkcePair();
    const state = base64Url(crypto.randomBytes(32));
    flows.set(state, { provider, verifier, redirectUri, createdAt: now() });
    return { state, verifier, challenge, redirectUri };
  }

  async function ensureDiscordClient(current) {
    if (current.values.DISCORD_OAUTH_CLIENT_ID) return current.values.DISCORD_OAUTH_CLIENT_ID;
    const metadata = await jsonRequest(`${DISCORD_ISSUER}.well-known/oauth-authorization-server`, {}, fetchImpl);
    const registered = await jsonRequest(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Radar Personal Assistant",
        redirect_uris: ["http://127.0.0.1:8790/oauth/discord/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }, fetchImpl);
    const clientId = requireValue(registered.client_id, "Discord OAuth registration did not return a client ID");
    updateLocalSettings({ values: { DISCORD_OAUTH_CLIENT_ID: clientId } }, { environment, codec });
    return clientId;
  }

  async function start(provider) {
    const current = settings();
    const ownerEmail = requireValue(current.values.RADAR_OWNER_EMAIL, "Save your owner email before connecting an account");

    if (provider === "google") {
      const clientId = requireValue(current.values.GMAIL_CLIENT_ID, "Import or enter a Google Desktop OAuth client first");
      const flow = createFlow(provider, "http://127.0.0.1:8790");
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries({
        client_id: clientId,
        redirect_uri: flow.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPE,
        access_type: "offline",
        prompt: "consent select_account",
        state: flow.state,
        code_challenge: flow.challenge,
        code_challenge_method: "S256",
        login_hint: ownerEmail,
      })) url.searchParams.set(key, value);
      return { authorizationUrl: url.toString() };
    }

    if (provider === "slack") {
      const clientId = requireValue(current.values.SLACK_CLIENT_ID, "Enter the PKCE-enabled Slack app client ID first");
      const flow = createFlow(provider, "http://localhost:8790/oauth/slack/callback");
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("user_scope", SLACK_SCOPES.join(","));
      url.searchParams.set("redirect_uri", flow.redirectUri);
      url.searchParams.set("state", flow.state);
      url.searchParams.set("code_challenge", flow.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.toString() };
    }

    if (provider === "discord") {
      const clientId = await ensureDiscordClient(current);
      const metadata = await jsonRequest(`${DISCORD_ISSUER}.well-known/oauth-authorization-server`, {}, fetchImpl);
      const flow = createFlow(provider, "http://127.0.0.1:8790/oauth/discord/callback");
      const url = new URL(metadata.authorization_endpoint);
      for (const [key, value] of Object.entries({
        client_id: clientId,
        redirect_uri: flow.redirectUri,
        response_type: "code",
        scope: "mcp:read",
        state: flow.state,
        code_challenge: flow.challenge,
        code_challenge_method: "S256",
      })) url.searchParams.set(key, value);
      return { authorizationUrl: url.toString() };
    }
    throw new Error("Unsupported OAuth provider");
  }

  async function complete(callbackUrl) {
    const url = new URL(callbackUrl, "http://127.0.0.1:8790");
    const state = url.searchParams.get("state") ?? "";
    const flow = flows.get(state);
    if (!flow) throw new Error("This authorization request is invalid or has already been used");
    flows.delete(state);
    if (now() - flow.createdAt > FLOW_TTL_MS) throw new Error("This authorization request expired; start it again from Radar");
    if (url.searchParams.get("error")) throw new Error(`Authorization was not completed: ${url.searchParams.get("error")}`);
    const code = requireValue(url.searchParams.get("code"), "The authorization provider did not return a code");
    const current = settings();
    const expectedEmail = requireValue(current.values.RADAR_OWNER_EMAIL, "Owner email is not configured");

    if (flow.provider === "google") {
      const form = new URLSearchParams({
        client_id: current.values.GMAIL_CLIENT_ID,
        code,
        code_verifier: flow.verifier,
        grant_type: "authorization_code",
        redirect_uri: flow.redirectUri,
      });
      if (current.secrets.GMAIL_CLIENT_SECRET) form.set("client_secret", current.secrets.GMAIL_CLIENT_SECRET);
      const token = await jsonRequest("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
      }, fetchImpl);
      const refreshToken = requireValue(token.refresh_token, "Google did not return a refresh token; revoke the existing Radar grant and try again");
      const profile = await jsonRequest("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }, fetchImpl);
      exactOwner(expectedEmail, profile.emailAddress, "Gmail");
      updateLocalSettings({
        values: { GMAIL_CONNECTED_EMAIL: profile.emailAddress, GMAIL_CONNECTED_AT: new Date(now()).toISOString() },
        secrets: { GMAIL_REFRESH_TOKEN: refreshToken },
      }, { environment, codec });
      return { provider: "google", email: profile.emailAddress };
    }

    if (flow.provider === "slack") {
      const token = await jsonRequest("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: current.values.SLACK_CLIENT_ID,
          code,
          code_verifier: flow.verifier,
          redirect_uri: flow.redirectUri,
        }),
      }, fetchImpl);
      const userToken = token.authed_user ?? token;
      const accessToken = requireValue(userToken.access_token, "Slack did not return a user access token");
      const auth = await jsonRequest("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${accessToken}` } }, fetchImpl);
      const user = await jsonRequest(`https://slack.com/api/users.info?user=${encodeURIComponent(auth.user_id)}`, { headers: { authorization: `Bearer ${accessToken}` } }, fetchImpl);
      const email = user.user?.profile?.email ?? "";
      exactOwner(expectedEmail, email, "Slack");
      updateLocalSettings({
        values: {
          SLACK_CONNECTED_EMAIL: email,
          SLACK_CONNECTED_AT: new Date(now()).toISOString(),
          SLACK_ACCESS_TOKEN_EXPIRES_AT: expiresAt(userToken.expires_in, now),
        },
        secrets: {
          SLACK_ACCESS_TOKEN: accessToken,
          ...(userToken.refresh_token ? { SLACK_REFRESH_TOKEN: userToken.refresh_token } : {}),
        },
      }, { environment, codec });
      return { provider: "slack", email };
    }

    const metadata = await jsonRequest(`${DISCORD_ISSUER}.well-known/oauth-authorization-server`, {}, fetchImpl);
    const token = await jsonRequest(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: current.values.DISCORD_OAUTH_CLIENT_ID,
        code,
        code_verifier: flow.verifier,
        grant_type: "authorization_code",
        redirect_uri: flow.redirectUri,
      }),
    }, fetchImpl);
    updateLocalSettings({
      values: { DISCORD_ACCESS_TOKEN_EXPIRES_AT: expiresAt(token.expires_in, now), DISCORD_CONNECTED_AT: new Date(now()).toISOString() },
      secrets: {
        DISCORD_MCP_API_KEY: requireValue(token.access_token, "Discord authorization did not return an access token"),
        ...(token.refresh_token ? { DISCORD_REFRESH_TOKEN: token.refresh_token } : {}),
      },
    }, { environment, codec });
    return { provider: "discord" };
  }

  function callbackMatches(url) {
    const parsed = new URL(url, "http://127.0.0.1:8790");
    if (!parsed.searchParams.get("state")) return false;
    return parsed.pathname === "/" || parsed.pathname === "/oauth/slack/callback" || parsed.pathname === "/oauth/discord/callback";
  }

  return { start, complete, callbackMatches };
}

export { SLACK_SCOPES };
