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
    environment: { RADAR_CONFIG_DIR: directory },
    secret: "broker-secret",
    codec,
    folderPicker: () => "C:\\Notes\\Vault",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/connections`)).status, 401);
    const headers = { authorization: "Bearer broker-secret", "content-type": "application/json" };
    const saved = await fetch(`${origin}/connections`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        values: { RADAR_OWNER_EMAIL: "owner@example.com" },
        secrets: { OPENAI_API_KEY: "private-key" },
      }),
    });
    const payload = await saved.json();
    assert.equal(payload.restartRequired, true);
    assert.equal(payload.owner.email, "owner@example.com");
    assert.equal(payload.generator.apiKeyStored, true);
    assert.doesNotMatch(JSON.stringify(payload), /private-key/);

    const folder = await fetch(`${origin}/folders/obsidian`, { method: "POST", headers, body: "{}" });
    assert.deepEqual(await folder.json(), { selected: "C:\\Notes\\Vault" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
