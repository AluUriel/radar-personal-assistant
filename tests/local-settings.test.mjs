import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadLocalSettingsEnvironment,
  localSettingsPath,
  readLocalSettings,
  redactedLocalSettings,
  updateLocalSettings,
} from "../scripts/lib/local-settings.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-settings-"));
  const environment = { RADAR_CONFIG_DIR: directory };
  const codec = {
    protect(value) { return `test-cipher:${Buffer.from(value).toString("base64")}`; },
    unprotect(value) { return Buffer.from(value.slice("test-cipher:".length), "base64").toString(); },
  };
  return { directory, environment, codec };
}

test("local settings encrypt secrets and keep them outside the project", () => {
  const { directory, environment, codec } = fixture();
  try {
    updateLocalSettings({
      values: { RADAR_OWNER_EMAIL: "owner@example.com", DISCORD_MCP_URL: "https://discord.example/mcp" },
      secrets: { OPENAI_API_KEY: "secret-api-key" },
    }, { environment, codec });
    const raw = fs.readFileSync(localSettingsPath(environment), "utf8");
    assert.doesNotMatch(raw, /secret-api-key/);
    assert.match(raw, /test-cipher:/);
    assert.deepEqual(readLocalSettings({ environment, codec }).secrets, { OPENAI_API_KEY: "secret-api-key" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime settings include safe defaults, internal secrets, and explicit environment overrides", () => {
  const { directory, environment, codec } = fixture();
  try {
    updateLocalSettings({ values: { OPENAI_MODEL: "stored-model" } }, { environment, codec });
    const runtime = loadLocalSettingsEnvironment({ ...environment, OPENAI_MODEL: "environment-model" }, { codec });
    assert.equal(runtime.OPENAI_MODEL, "environment-model");
    assert.equal(runtime.DISCORD_MCP_URL, "https://discord-knowledge-mvp-production.up.railway.app/mcp");
    assert.ok(runtime.RADAR_INGEST_SECRET);
    assert.equal(runtime.TEXT_GENERATOR_API_KEY, runtime.SIDECAR_SHARED_SECRET);
    const status = redactedLocalSettings(environment, { codec });
    assert.equal(status.secrets.RADAR_INGEST_SECRET, true);
    assert.equal(status.secrets.SIDECAR_SHARED_SECRET, true);
    assert.equal("OPENAI_API_KEY" in status.values, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the settings allowlist rejects arbitrary or oversized values", () => {
  const { directory, environment, codec } = fixture();
  try {
    assert.throws(() => updateLocalSettings({ secrets: { UNKNOWN_TOKEN: "nope" } }, { environment, codec }), /Unsupported setting/);
    assert.throws(() => updateLocalSettings({ values: { RADAR_OWNER_EMAIL: "x".repeat(20_000) } }, { environment, codec }), /too long/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
