import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalSetupServer } from "../scripts/lib/local-setup-server.mjs";

const codec = {
  protect(value) { return `test:${Buffer.from(value).toString("base64")}`; },
  unprotect(value) { return Buffer.from(value.slice(5), "base64").toString(); },
};

test("the loopback setup service requires its bearer secret and never returns stored values", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-setup-"));
  const server = createLocalSetupServer({
    environment: { RADAR_CONFIG_DIR: directory, RADAR_URL: "http://localhost:3000" },
    secret: "broker-secret",
    codec,
    folderPicker: () => "C:\\Notes\\Vault",
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init.body));
      return request.params?.name === "list_users"
        ? Response.json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { results: [{ id: "U1", username: "alu", display_name: "Alu", is_bot: false }] } } })
        : Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/connections`)).status, 401);
    assert.equal((await fetch(`${origin}/connections`, { headers: { origin: "https://malicious.example" } })).status, 401);
    const browserStatus = await fetch(`${origin}/connections`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(browserStatus.status, 200);
    assert.equal(browserStatus.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal((await fetch(`${origin}/connections`, { method: "PATCH", headers: { origin: "http://localhost:3000", "content-type": "text/plain" }, body: "{}" })).status, 415);
    const headers = { authorization: "Bearer broker-secret", "content-type": "application/json" };
    const saved = await fetch(`${origin}/connections`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        values: { RADAR_OWNER_EMAIL: "owner@example.com", GMAIL_CLIENT_ID: "google-client" },
        secrets: { OPENAI_API_KEY: "private-key", DISCORD_MCP_API_KEY: "discord-token" },
      }),
    });
    const payload = await saved.json();
    assert.equal(payload.restartRequired, true);
    assert.equal(payload.owner.email, "owner@example.com");
    assert.equal(payload.generator.apiKeyStored, true);
    assert.doesNotMatch(JSON.stringify(payload), /private-key/);

    const oauthStart = await fetch(`${origin}/oauth/google/start`, { method: "POST", headers, body: "{}" });
    const oauthPayload = await oauthStart.json();
    assert.equal(oauthStart.status, 200);
    assert.match(oauthPayload.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);

    const discordUsers = await fetch(`${origin}/discord/users`, { method: "POST", headers, body: JSON.stringify({ query: "alu" }) });
    assert.deepEqual(await discordUsers.json(), { users: [{ id: "U1", username: "alu", displayName: "Alu" }] });

    const folder = await fetch(`${origin}/folders/obsidian`, { method: "POST", headers, body: "{}" });
    assert.deepEqual(await folder.json(), { selected: "C:\\Notes\\Vault" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
