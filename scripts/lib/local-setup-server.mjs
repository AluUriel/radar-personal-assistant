import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import {
  redactedLocalSettings,
  updateLocalSettings,
  windowsDpapiCodec,
} from "./local-settings.mjs";

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
        oauthClientReady: Boolean(value("SLACK_CLIENT_ID") && secret("SLACK_CLIENT_SECRET")),
        clientId: value("SLACK_CLIENT_ID"),
        accessTokenStored: secret("SLACK_ACCESS_TOKEN"),
      },
      gmail: {
        state: secret("GMAIL_REFRESH_TOKEN") ? "configured" : "needs-configuration",
        oauthClientReady: Boolean(value("GMAIL_CLIENT_ID") && secret("GMAIL_CLIENT_SECRET")),
        clientId: value("GMAIL_CLIENT_ID"),
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

export function createLocalSetupServer({
  environment = process.env,
  secret = environment.RADAR_SETUP_SECRET,
  codec = windowsDpapiCodec,
  folderPicker = pickWindowsFolder,
} = {}) {
  if (!secret?.trim()) throw new Error("RADAR_SETUP_SECRET is required");
  const radarOrigin = new URL(environment.RADAR_URL?.trim() || "http://localhost:3000");
  const trustedOrigins = new Set([
    radarOrigin.origin,
    `${radarOrigin.protocol}//${radarOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost"}${radarOrigin.port ? `:${radarOrigin.port}` : ""}`,
  ]);
  return http.createServer(async (request, response) => {
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
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
      send(response, 404, { error: "not-found" });
    } catch (error) {
      send(response, 400, { error: error instanceof SyntaxError ? "invalid-json" : error instanceof Error ? error.message : "request-failed" });
    }
  });
}
