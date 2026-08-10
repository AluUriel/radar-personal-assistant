#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { indexObsidianVault } from "./lib/obsidian-indexer.mjs";
import { loadApprovedScope } from "./lib/obsidian-scope.mjs";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const vaultPath = valueAfter("--vault") ?? positional[0];
const scopePath = valueAfter("--scope") ?? positional[1];
const outputPath = valueAfter("--out") ?? positional[2];
const includeNestedRepos = process.argv.includes("--include-nested-repos");

if (!vaultPath || !outputPath || !scopePath) {
  console.error("Usage: node scripts/index-obsidian.mjs --vault <vault> --scope <approved-scope.json> --out <outside-vault.ndjson> [--include-nested-repos]");
  process.exit(2);
}

const absoluteOutput = path.resolve(outputPath);
const scope = await loadApprovedScope(scopePath);
const result = await indexObsidianVault({ vaultPath, scope, includeNestedRepos });
const relativeOutput = path.relative(result.root, absoluteOutput);
if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) {
  throw new Error("Refusing to write the generated index inside the Obsidian vault");
}

await mkdir(path.dirname(absoluteOutput), { recursive: true });
const temporary = `${absoluteOutput}.${process.pid}.tmp`;
const body = result.documents.map((document) => JSON.stringify(document)).join("\n") + (result.documents.length ? "\n" : "");
await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
await rename(temporary, absoluteOutput);
console.log(JSON.stringify({ output: absoluteOutput, ...result.stats }));
