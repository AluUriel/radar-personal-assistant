#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { uploadKnowledgeBatches } from "./lib/knowledge-upload.mjs";
import { indexObsidianVault } from "../scripts/lib/obsidian-indexer.mjs";
import { loadApprovedScope } from "../scripts/lib/obsidian-scope.mjs";

function completeCoverage(stats) {
  return stats.skippedLarge === 0
    && stats.skippedLinks === 0
    && stats.skippedNestedRepos === 0
    && stats.skippedUnreadable === 0;
}

export async function collectObsidian({
  vaultPath,
  scopePath,
  radarUrl,
  secret,
  includeNestedRepos = false,
  fetchImpl = fetch,
}) {
  const startedAt = new Date().toISOString();
  // Approval is validated before indexObsidianVault can read any note body.
  const scope = await loadApprovedScope(scopePath);
  const result = await indexObsidianVault({ vaultPath, scope, includeNestedRepos });
  const completedAt = new Date().toISOString();
  const complete = completeCoverage(result.stats);
  const coverageDetail = JSON.stringify({
    scopeApproved: true,
    includeNestedRepos,
    ...result.stats,
  });
  const upload = await uploadKnowledgeBatches({
    radarUrl,
    secret,
    documents: result.documents,
    sourceSync: {
      id: `obsidian:${startedAt}`,
      source: "obsidian",
      startedAt,
      completedAt,
      documentCount: result.documents.length,
      coverage: { complete, detail: coverageDetail },
    },
    fetchImpl,
  });
  return { uploaded: upload.uploaded, coverageComplete: complete, stats: result.stats };
}

async function main() {
  const required = ["OBSIDIAN_VAULT_PATH", "OBSIDIAN_SCOPE_PATH", "RADAR_URL", "RADAR_INGEST_SECRET"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(", ")}`);
  const result = await collectObsidian({
    vaultPath: process.env.OBSIDIAN_VAULT_PATH,
    scopePath: process.env.OBSIDIAN_SCOPE_PATH,
    radarUrl: process.env.RADAR_URL,
    secret: process.env.RADAR_INGEST_SECRET,
    includeNestedRepos: process.env.OBSIDIAN_INCLUDE_NESTED_REPOS?.trim().toLowerCase() === "true",
  });
  console.log(JSON.stringify({ event: "obsidian-sync-complete", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Obsidian collection failed");
    process.exitCode = 1;
  });
}
