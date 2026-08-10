#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { inventoryObsidianScope } from "./lib/obsidian-scope.mjs";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const vaultPath = valueAfter("--vault") ?? process.env.OBSIDIAN_VAULT_PATH ?? positional[0];
const outputPath = valueAfter("--out") ?? positional[1] ?? ".radar-data/obsidian-scope.proposed.json";
if (!vaultPath) {
  console.error("Usage: npm run scope:obsidian -- --vault <vault> [--out <proposal.json>]");
  process.exit(2);
}

const inventory = await inventoryObsidianScope(vaultPath);
const output = path.resolve(outputPath);
const relativeOutput = path.relative(inventory.root, output);
if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) {
  throw new Error("Refusing to write the scope proposal inside the Obsidian vault");
}

const proposal = {
  version: 1,
  approved: false,
  include: [],
  exclude: [],
  note: "Folder names and Markdown counts only. Add explicit paths to include, review exclusions, then set approved to true.",
  inventory: inventory.candidates,
};
await mkdir(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await rename(temporary, output);
console.log(JSON.stringify({ output, candidates: inventory.candidates.length, markdownFiles: inventory.candidates.reduce((total, item) => total + item.markdownFiles, 0), noteBodiesRead: 0 }));
