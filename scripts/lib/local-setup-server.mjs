import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import {
  readLocalSettings,
  redactedLocalSettings,
  updateLocalSettings,
  windowsDpapiCodec,
} from "./local-settings.mjs";
import { createLocalOAuthManager } from "./local-oauth.mjs";
import { callDiscordMcpTool } from "./discord-mcp-client.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function sameSecret(left, right) {
  const expected = Buffer.from(left ?? "");
  const received = Buffer.from(right ?? "");
  return expected.length > 0 && expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function bearerToken(request) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function send(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function sendOAuthPage(response, result) {
  const successful = result.ok;
  const title = successful ? "Connection complete" : "Connection failed";
  const detail = successful
    ? `${result.provider === "google" ? "Gmail" : result.provider === "slack" ? "Slack" : "Discord"} is connected. You can close this window.`
    : `${result.message} Close this window and try again from Radar.`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f3;color:#18201d;font:16px system-ui"><main style="max-width:520px;padding:40px;text-align:center"><div style="width:42px;height:42px;margin:0 auto 18px;display:grid;place-items:center;border-radius:12px;background:${successful ? "#466b54" : "#9b531f"};color:white;font-weight:800">${successful ? "✓" : "!"}</div><h1 style="font-size:26px">${title}</h1><p style="color:#6c746f;line-height:1.6">${escapeHtml(detail)}</p></main></body></html>`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function buildConnectionStatus(environment = process.env, options = {}) {
  const settings = redactedLocalSettings(environment, options);
  const value = (name) => settings.values[name] ?? "";
  const secret = (name) => Boolean(settings.secrets[name]);
  return {
    storage: { protectedBy: "Windows DPAPI for the current user", location: "Outside the repository and OneDrive" },
    owner: { email: value("RADAR_OWNER_EMAIL") },
    sources: {
      slack: {
        state: secret("SLACK_ACCESS_TOKEN") ? "configured" : "needs-configuration",
        ownerEmail: value("SLACK_OWNER_EMAIL") || value("RADAR_OWNER_EMAIL"),
        oauthClientReady: Boolean(value("SLACK_CLIENT_ID")),
        clientId: value("SLACK_CLIENT_ID"),
        connectedEmail: value("SLACK_CONNECTED_EMAIL"),
        connectedAt: value("SLACK_CONNECTED_AT"),
        accessTokenStored: secret("SLACK_ACCESS_TOKEN"),
      },
      gmail: {
        state: secret("GMAIL_REFRESH_TOKEN") ? "configured" : "needs-configuration",
        oauthClientReady: Boolean(value("GMAIL_CLIENT_ID")),
        clientId: value("GMAIL_CLIENT_ID"),
        connectedEmail: value("GMAIL_CONNECTED_EMAIL"),
        connectedAt: value("GMAIL_CONNECTED_AT"),
        refreshTokenStored: secret("GMAIL_REFRESH_TOKEN"),
        query: value("GMAIL_QUERY"),
        intercomQuery: value("INTERCOM_GMAIL_QUERY"),
      },
      discord: {
        state: value("DISCORD_MCP_URL") && secret("DISCORD_MCP_API_KEY") && value("DISCORD_OWNER_USER_ID") && value("DISCORD_OWNER_QUERY")
          ? "configured"
          : "needs-configuration",
        url: value("DISCORD_MCP_URL"),
        apiKeyStored: secret("DISCORD_MCP_API_KEY"),
        oauthClientRegistered: Boolean(value("DISCORD_OAUTH_CLIENT_ID")),
        connectedAt: value("DISCORD_CONNECTED_AT"),
        ownerUserId: value("DISCORD_OWNER_USER_ID"),
        ownerQuery: value("DISCORD_OWNER_QUERY"),
      },
      obsidian: {
        state: value("OBSIDIAN_VAULT_PATH") ? "configured" : "needs-configuration",
        vaultPath: value("OBSIDIAN_VAULT_PATH"),
        scopePath: value("OBSIDIAN_SCOPE_PATH"),
      },
    },
    generator: {
      state: secret("OPENAI_API_KEY") ? "configured" : "needs-configuration",
      apiKeyStored: secret("OPENAI_API_KEY"),
      model: value("OPENAI_MODEL"),
      authentication: "OpenAI API key",
    },
  };
}

export function pickWindowsFolder() {
  if (process.platform !== "win32") throw new Error("The native folder picker is available on Windows only");
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = "Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='Choose your Obsidian vault';$dialog.ShowNewFolderButton=$false;if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($dialog.SelectedPath)}";
  return execFileSync(executable, ["-NoLogo", "-NoProfile", "-STA", "-Command", script], {
    encoding: "utf8",
    windowsHide: false,
    timeout: 10 * 60 * 1000,
  }).trim();
}

async function findDiscordUsers(query, environment, codec, fetchImpl) {
  if (typeof query !== "string" || !query.trim() || query.trim().length > 100) throw new Error("Enter a Discord name to search");
  const current = redactedLocalSettings(environment, { codec });
  const stored = readLocalSettings({ environment, codec });
  const token = stored.secrets.DISCORD_MCP_API_KEY;
  if (!token) throw new Error("Authorize Discord before choosing your profile");
  const payload = await callDiscordMcpTool({
    mcpUrl: current.values.DISCORD_MCP_URL,
    token,
    name: "list_users",
    args: { query: query.trim(), limit: 25 },
    fetchImpl,
  });
  if (!Array.isArray(payload.results)) throw new Error("Discord profile search returned an invalid response");
  return payload.results
    .filter((user) => user?.id && !user.is_bot)
    .slice(0, 25)
    .map((user) => ({ id: String(user.id), username: String(user.username || ""), displayName: String(user.display_name || user.username || user.id) }));
}

export function createLocalSetupServer({
  environment = process.env,
  secret = environment.RADAR_SETUP_SECRET,
  codec = windowsDpapiCodec,
  folderPicker = pickWindowsFolder,
  fetchImpl = fetch,
} = {}) {
  if (!secret?.trim()) throw new Error("RADAR_SETUP_SECRET is required");
  const radarOrigin = new URL(environment.RADAR_URL?.trim() || "http://localhost:3000");
  const trustedOrigins = new Set([
    radarOrigin.origin,
    `${radarOrigin.protocol}//${radarOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost"}${radarOrigin.port ? `:${radarOrigin.port}` : ""}`,
  ]);
  const oauth = createLocalOAuthManager({ environment, codec, fetchImpl });
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && oauth.callbackMatches(url)) {
      try {
        const result = await oauth.complete(url);
        sendOAuthPage(response, { ok: true, ...result });
      } catch (error) {
        sendOAuthPage(response, { ok: false, message: error instanceof Error ? error.message : "Authorization could not be completed" });
      }
      return;
    }
    const origin = request.headers.origin ?? "";
    const trustedBrowser = trustedOrigins.has(origin);
    if (trustedBrowser) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "GET, PATCH, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(trustedBrowser ? 204 : 403);
      response.end();
      return;
    }
    if (!sameSecret(secret, bearerToken(request)) && !trustedBrowser) {
      send(response, 401, { error: "not-authorized" });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/connections") {
        send(response, 200, buildConnectionStatus(environment, { codec }));
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/connections") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          send(response, 415, { error: "json-required" });
          return;
        }
        const body = await readJson(request);
        updateLocalSettings({ values: body.values, secrets: body.secrets }, { environment, codec });
        send(response, 200, { ...buildConnectionStatus(environment, { codec }), restartRequired: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/folders/obsidian") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          send(response, 415, { error: "json-required" });
          return;
        }
        const selected = folderPicker();
        send(response, 200, { selected: selected || null });
        return;
      }
      if (request.method === "POST" && url.pathname === "/discord/users") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          send(response, 415, { error: "json-required" });
          return;
        }
        const body = await readJson(request);
        send(response, 200, { users: await findDiscordUsers(body.query, environment, codec, fetchImpl) });
        return;
      }
      const oauthStart = url.pathname.match(/^\/oauth\/(google|slack|discord)\/start$/);
      if (request.method === "POST" && oauthStart) {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          send(response, 415, { error: "json-required" });
          return;
        }
        await readJson(request);
        send(response, 200, await oauth.start(oauthStart[1]));
        return;
      }
      send(response, 404, { error: "not-found" });
    } catch (error) {
      send(response, 400, { error: error instanceof SyntaxError ? "invalid-json" : error instanceof Error ? error.message : "request-failed" });
    }
  });
}
