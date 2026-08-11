import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PUBLIC_SETTING_NAMES = Object.freeze([
  "RADAR_OWNER_EMAIL",
  "RADAR_URL",
  "RADAR_SYNC_INTERVAL_MINUTES",
  "RADAR_SYNC_SOURCES",
  "DISCORD_MCP_URL",
  "DISCORD_OWNER_USER_ID",
  "DISCORD_OWNER_QUERY",
  "OBSIDIAN_VAULT_PATH",
  "OBSIDIAN_SCOPE_PATH",
  "SLACK_OWNER_EMAIL",
  "SLACK_CLIENT_ID",
  "SLACK_CONNECTED_EMAIL",
  "SLACK_CONNECTED_AT",
  "SLACK_ACCESS_TOKEN_EXPIRES_AT",
  "GMAIL_CLIENT_ID",
  "GMAIL_CONNECTED_EMAIL",
  "GMAIL_CONNECTED_AT",
  "GMAIL_QUERY",
  "INTERCOM_GMAIL_QUERY",
  "DISCORD_OAUTH_CLIENT_ID",
  "DISCORD_CONNECTED_AT",
  "DISCORD_ACCESS_TOKEN_EXPIRES_AT",
  "OPENAI_MODEL",
]);

export const SECRET_SETTING_NAMES = Object.freeze([
  "RADAR_INGEST_SECRET",
  "DISCORD_MCP_API_KEY",
  "SLACK_ACCESS_TOKEN",
  "SLACK_REFRESH_TOKEN",
  "SLACK_CLIENT_SECRET",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "DISCORD_REFRESH_TOKEN",
  "OPENAI_API_KEY",
  "SIDECAR_SHARED_SECRET",
]);

const PUBLIC_NAMES = new Set(PUBLIC_SETTING_NAMES);
const SECRET_NAMES = new Set(SECRET_SETTING_NAMES);
const DEFAULT_VALUES = Object.freeze({
  RADAR_URL: "http://localhost:3000",
  RADAR_SYNC_INTERVAL_MINUTES: "15",
  DISCORD_MCP_URL: "https://discord-knowledge-mvp-production.up.railway.app/mcp",
  OBSIDIAN_SCOPE_PATH: ".radar-data\\obsidian-scope.approved.json",
  GMAIL_QUERY: "in:anywhere -in:spam -in:trash",
  INTERCOM_GMAIL_QUERY: "from:intercom",
  OPENAI_MODEL: "gpt-5.6-sol",
});

const SETTINGS_FILE = "settings.json";
const DPAPI_PREFIX = "dpapi-current-user-v1:";
const MAX_SETTING_LENGTH = 16_384;

function powershellExecutable() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function runDpapi(script, input) {
  if (process.platform !== "win32") {
    throw new Error("Radar secret storage currently requires Windows DPAPI");
  }
  return execFileSync(
    powershellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
  ).trim();
}

export const windowsDpapiCodec = Object.freeze({
  protect(value) {
    const encoded = runDpapi(
      "Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))",
      value,
    );
    return `${DPAPI_PREFIX}${encoded}`;
  },
  unprotect(value) {
    if (!value.startsWith(DPAPI_PREFIX)) throw new Error("Unsupported encrypted setting format");
    return runDpapi(
      "Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($value);$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
      value.slice(DPAPI_PREFIX.length),
    );
  },
});

export function localSettingsDirectory(environment = process.env) {
  const explicit = environment.RADAR_CONFIG_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "Radar");
  return path.join(os.homedir(), "AppData", "Local", "Radar");
}

export function localSettingsPath(environment = process.env) {
  return path.join(localSettingsDirectory(environment), SETTINGS_FILE);
}

function cleanSettingValue(name, value, allowedNames) {
  if (!allowedNames.has(name)) throw new Error(`Unsupported setting: ${name}`);
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const clean = value.trim();
  if (clean.length > MAX_SETTING_LENGTH) throw new Error(`${name} is too long`);
  return clean;
}

function emptyDocument() {
  return { version: 1, values: {}, secrets: {} };
}

export function readLocalSettings({ environment = process.env, codec = windowsDpapiCodec } = {}) {
  const file = localSettingsPath(environment);
  if (!fs.existsSync(file)) return { ...emptyDocument(), path: file };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.version !== 1 || typeof parsed.values !== "object" || typeof parsed.secrets !== "object") {
    throw new Error("Radar settings file has an unsupported format");
  }
  const values = {};
  const secrets = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    if (PUBLIC_NAMES.has(name) && typeof value === "string") values[name] = value;
  }
  for (const [name, value] of Object.entries(parsed.secrets)) {
    if (SECRET_NAMES.has(name) && typeof value === "string") secrets[name] = codec.unprotect(value);
  }
  return { version: 1, values, secrets, path: file };
}

export function updateLocalSettings(
  updates,
  { environment = process.env, codec = windowsDpapiCodec } = {},
) {
  const current = readLocalSettings({ environment, codec });
  const values = { ...current.values };
  const secrets = { ...current.secrets };

  for (const [name, value] of Object.entries(updates.values ?? {})) {
    const clean = cleanSettingValue(name, value, PUBLIC_NAMES);
    if (clean) values[name] = clean;
    else delete values[name];
  }
  for (const [name, value] of Object.entries(updates.secrets ?? {})) {
    if (value === null) {
      if (!SECRET_NAMES.has(name)) throw new Error(`Unsupported setting: ${name}`);
      delete secrets[name];
      continue;
    }
    const clean = cleanSettingValue(name, value, SECRET_NAMES);
    if (clean) secrets[name] = clean;
  }

  const directory = localSettingsDirectory(environment);
  fs.mkdirSync(directory, { recursive: true });
  const document = {
    version: 1,
    values,
    secrets: Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, codec.protect(value)])),
  };
  const temporary = path.join(directory, `${SETTINGS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, current.path);
  return { version: 1, values, secrets, path: current.path };
}

export function ensureLocalInternalSecrets(options = {}) {
  const current = readLocalSettings(options);
  const updates = { secrets: {} };
  if (!current.secrets.RADAR_INGEST_SECRET) updates.secrets.RADAR_INGEST_SECRET = crypto.randomBytes(32).toString("base64url");
  if (!current.secrets.SIDECAR_SHARED_SECRET) updates.secrets.SIDECAR_SHARED_SECRET = crypto.randomBytes(32).toString("base64url");
  if (!Object.keys(updates.secrets).length) return current;
  return updateLocalSettings(updates, options);
}

export function loadLocalSettingsEnvironment(environment = process.env, options = {}) {
  const { preferStored = false, ...storageOptions } = options;
  const stored = ensureLocalInternalSecrets({ environment, ...storageOptions });
  const merged = preferStored
    ? { ...DEFAULT_VALUES, ...environment, ...stored.values, ...stored.secrets }
    : { ...DEFAULT_VALUES, ...stored.values, ...stored.secrets, ...environment };
  if (stored.secrets.SIDECAR_SHARED_SECRET) {
    merged.TEXT_GENERATOR_API_KEY ||= stored.secrets.SIDECAR_SHARED_SECRET;
    merged.TEXT_GENERATOR_URL ||= "http://127.0.0.1:8789/draft";
    merged.SIDECAR_PORT ||= "8789";
    merged.SIDECAR_HOST ||= "127.0.0.1";
  }
  merged.SLACK_OWNER_EMAIL ||= merged.RADAR_OWNER_EMAIL;
  return merged;
}

export function redactedLocalSettings(environment = process.env, options = {}) {
  const stored = readLocalSettings({ environment, ...options });
  return {
    path: stored.path,
    values: { ...DEFAULT_VALUES, ...stored.values },
    secrets: Object.fromEntries(SECRET_SETTING_NAMES.map((name) => [name, Boolean(stored.secrets[name])])),
  };
}
