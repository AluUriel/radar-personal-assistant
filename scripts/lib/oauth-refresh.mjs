import { updateLocalSettings, windowsDpapiCodec } from "./local-settings.mjs";

function expiring(value, now) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now() + 5 * 60 * 1000;
}

async function exchange(url, form, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`OAuth refresh failed for ${new URL(url).hostname}`);
  }
  return payload;
}

export async function refreshOAuthAccessTokens(environment, {
  fetchImpl = fetch,
  now = Date.now,
  codec = windowsDpapiCodec,
} = {}) {
  const next = { ...environment };
  if (next.SLACK_REFRESH_TOKEN && (!next.SLACK_ACCESS_TOKEN || expiring(next.SLACK_ACCESS_TOKEN_EXPIRES_AT, now))) {
    const payload = await exchange("https://slack.com/api/oauth.v2.access", {
      grant_type: "refresh_token",
      refresh_token: next.SLACK_REFRESH_TOKEN,
      client_id: next.SLACK_CLIENT_ID,
    }, fetchImpl);
    const token = payload.authed_user ?? payload;
    if (!token.access_token) throw new Error("Slack OAuth refresh did not return an access token");
    next.SLACK_ACCESS_TOKEN = token.access_token;
    next.SLACK_REFRESH_TOKEN = token.refresh_token ?? next.SLACK_REFRESH_TOKEN;
    next.SLACK_ACCESS_TOKEN_EXPIRES_AT = token.expires_in ? new Date(now() + Number(token.expires_in) * 1_000).toISOString() : "";
    updateLocalSettings({
      values: { SLACK_ACCESS_TOKEN_EXPIRES_AT: next.SLACK_ACCESS_TOKEN_EXPIRES_AT },
      secrets: { SLACK_ACCESS_TOKEN: next.SLACK_ACCESS_TOKEN, SLACK_REFRESH_TOKEN: next.SLACK_REFRESH_TOKEN },
    }, { environment, codec });
  }
  if (next.DISCORD_REFRESH_TOKEN && (!next.DISCORD_MCP_API_KEY || expiring(next.DISCORD_ACCESS_TOKEN_EXPIRES_AT, now))) {
    const payload = await exchange("https://discord-knowledge-mvp-production.up.railway.app/token", {
      grant_type: "refresh_token",
      refresh_token: next.DISCORD_REFRESH_TOKEN,
      client_id: next.DISCORD_OAUTH_CLIENT_ID,
    }, fetchImpl);
    if (!payload.access_token) throw new Error("Discord OAuth refresh did not return an access token");
    next.DISCORD_MCP_API_KEY = payload.access_token;
    next.DISCORD_REFRESH_TOKEN = payload.refresh_token ?? next.DISCORD_REFRESH_TOKEN;
    next.DISCORD_ACCESS_TOKEN_EXPIRES_AT = payload.expires_in ? new Date(now() + Number(payload.expires_in) * 1_000).toISOString() : "";
    updateLocalSettings({
      values: { DISCORD_ACCESS_TOKEN_EXPIRES_AT: next.DISCORD_ACCESS_TOKEN_EXPIRES_AT },
      secrets: { DISCORD_MCP_API_KEY: next.DISCORD_MCP_API_KEY, DISCORD_REFRESH_TOKEN: next.DISCORD_REFRESH_TOKEN },
    }, { environment, codec });
  }
  return next;
}
