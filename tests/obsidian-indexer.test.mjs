import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectObsidian } from "../collectors/obsidian.mjs";
import { indexObsidianVault } from "../scripts/lib/obsidian-indexer.mjs";
import { inventoryObsidianScope, validateApprovedScope } from "../scripts/lib/obsidian-scope.mjs";

test("indexes markdown with provenance and skips Obsidian internals and nested repositories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "radar-vault-"));
  try {
    await mkdir(path.join(root, ".obsidian"));
    await writeFile(path.join(root, ".obsidian", "private.md"), "# Internal");
    await mkdir(path.join(root, "Projects"));
    await writeFile(path.join(root, "Projects", "Heating.md"), "---\ntitle: Heating recovery\ntags: [support, heating]\n---\n# Ignored heading\nUse [[Runbook|the runbook]]. #customer");
    await mkdir(path.join(root, "Nested", ".git"), { recursive: true });
    await writeFile(path.join(root, "Nested", "Secret.md"), "# Nested repository note");
    await mkdir(path.join(root, "Private"));
    await writeFile(path.join(root, "Private", "Credentials.md"), "# Never index this secret body");

    const scope = validateApprovedScope({ version: 1, approved: true, include: ["Projects", "Nested"], exclude: [] });
    const result = await indexObsidianVault({ vaultPath: root, scope });
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].title, "Heating recovery");
    assert.equal(result.documents[0].sourceUri, "obsidian:Projects/Heating.md");
    assert.deepEqual(result.documents[0].links, ["Runbook"]);
    assert.ok(result.documents[0].tags.includes("customer"));
    assert.equal(result.stats.skippedNestedRepos, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope approval rejects unapproved, broad, and escaping paths", () => {
  assert.throws(() => validateApprovedScope({ version: 1, approved: false, include: ["Projects"] }), /explicitly approved/);
  assert.throws(() => validateApprovedScope({ version: 1, approved: true, include: ["."] }), /overly broad/);
  assert.throws(() => validateApprovedScope({ version: 1, approved: true, include: ["../outside"] }), /Unsafe/);
});

test("scope inventory returns names and counts without note bodies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "radar-vault-inventory-"));
  try {
    await mkdir(path.join(root, "Guides"));
    await writeFile(path.join(root, "Guides", "Recovery.md"), "PRIVATE BODY MUST NOT APPEAR");
    await writeFile(path.join(root, "Welcome.md"), "ANOTHER PRIVATE BODY");
    const inventory = await inventoryObsidianScope(root);
    assert.deepEqual(inventory.candidates.map((item) => [item.path, item.markdownFiles]), [["Guides", 1], ["Welcome.md", 1]]);
    assert.doesNotMatch(JSON.stringify(inventory.candidates), /PRIVATE BODY|ANOTHER PRIVATE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Obsidian collector refuses an unapproved scope before reading or uploading notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "radar-vault-unapproved-"));
  try {
    const notePath = path.join(root, "Private.md");
    const scopePath = path.join(root, "scope.json");
    await writeFile(notePath, "PRIVATE NOTE BODY");
    await writeFile(scopePath, JSON.stringify({ version: 1, approved: false, include: ["Private.md"], exclude: [] }));
    let uploads = 0;
    await assert.rejects(collectObsidian({
      vaultPath: root,
      scopePath,
      radarUrl: "http://localhost:3000",
      secret: "test-secret",
      fetchImpl: async () => {
        uploads += 1;
        return Response.json({ upserted: 1 }, { status: 202 });
      },
    }), /explicitly approved/);
    assert.equal(uploads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Obsidian collector uploads only approved notes and records complete coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "radar-vault-collector-"));
  try {
    await mkdir(path.join(root, "Projects"));
    await mkdir(path.join(root, "Private"));
    await writeFile(path.join(root, "Projects", "Recovery.md"), "# Recovery\nUse the verified reset procedure.");
    await writeFile(path.join(root, "Private", "Secret.md"), "PRIVATE NOTE MUST NOT UPLOAD");
    const scopePath = path.join(os.tmpdir(), `radar-scope-${process.pid}-${Date.now()}.json`);
    await writeFile(scopePath, JSON.stringify({ version: 1, approved: true, include: ["Projects"], exclude: [] }));
    const payloads = [];
    try {
      const result = await collectObsidian({
        vaultPath: root,
        scopePath,
        radarUrl: "http://localhost:3000",
        secret: "test-secret",
        fetchImpl: async (_input, init) => {
          payloads.push(JSON.parse(init.body));
          return Response.json({ upserted: 1 }, { status: 202 });
        },
      });
      assert.equal(result.uploaded, 1);
      assert.equal(result.coverageComplete, true);
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].documents[0].canonicalKey, "obsidian:Projects/Recovery.md");
      assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE NOTE MUST NOT UPLOAD/);
      assert.deepEqual(payloads[0].sourceSync.coverage.complete, true);
    } finally {
      await rm(scopePath, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
