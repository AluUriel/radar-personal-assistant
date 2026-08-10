#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { uploadKnowledgeBatches } from "../collectors/lib/knowledge-upload.mjs";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputPath = valueAfter("--in");
const endpoint = valueAfter("--endpoint") ?? process.env.RADAR_URL;
const secret = process.env.RADAR_INGEST_SECRET;
if (!inputPath || !endpoint || !secret) {
  console.error("Usage: set RADAR_URL and RADAR_INGEST_SECRET, then run node scripts/upload-knowledge.mjs --in <knowledge.ndjson>");
  process.exit(2);
}

const documents = (await readFile(inputPath, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const result = await uploadKnowledgeBatches({ radarUrl: endpoint, secret, documents });
console.log(JSON.stringify(result));
