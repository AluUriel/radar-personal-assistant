import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { scopeIncludesFile, scopeMayContainFiles } from "./obsidian-scope.mjs";

const DEFAULT_EXCLUDES = new Set([".git", ".obsidian", ".trash", "node_modules", ".radar-data"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    result[pair[1]] = pair[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return result;
}

function titleFor(content, fallback) {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter.title) return frontmatter.title;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

function tagsFor(content) {
  const inline = parseFrontmatter(content).tags ?? "";
  const fromInline = inline.replace(/^\[|\]$/g, "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
  const hashtags = Array.from(content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu), (match) => match[1]);
  return Array.from(new Set([...fromInline, ...hashtags])).slice(0, 100);
}

function linksFor(content) {
  return Array.from(new Set(Array.from(content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g), (match) => match[1].trim()))).slice(0, 500);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function indexObsidianVault({ vaultPath, scope, includeNestedRepos = false, maxFileBytes = MAX_FILE_BYTES }) {
  if (!scope?.include?.length) throw new Error("An approved Obsidian scope is required");
  const root = await realpath(path.resolve(vaultPath));
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("Obsidian vault path must be a directory");

  const documents = [];
  const stats = { indexed: 0, skippedLarge: 0, skippedLinks: 0, skippedNestedRepos: 0, skippedUnreadable: 0 };

  async function walk(directory, isRoot = false) {
    if (!isRoot && !includeNestedRepos) {
      try {
        const nestedGit = await lstat(path.join(directory, ".git"));
        if (nestedGit) {
          stats.skippedNestedRepos += 1;
          return;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      stats.skippedUnreadable += 1;
      return;
    }

    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        stats.skippedLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const relativeDirectory = path.relative(root, fullPath).split(path.sep).join("/");
        if (!scopeMayContainFiles(relativeDirectory, scope)) continue;
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;

      try {
        const resolved = await realpath(fullPath);
        if (!isWithin(resolved, root)) {
          stats.skippedLinks += 1;
          continue;
        }
        const relativePath = path.relative(root, resolved).split(path.sep).join("/");
        if (!scopeIncludesFile(relativePath, scope)) continue;
        const fileInfo = await stat(resolved);
        if (fileInfo.size > maxFileBytes) {
          stats.skippedLarge += 1;
          continue;
        }
        const content = await readFile(resolved, "utf8");
        const canonicalKey = `obsidian:${relativePath}`;
        documents.push({
          id: sha256(canonicalKey).slice(0, 24),
          canonicalKey,
          kind: "note",
          title: titleFor(content, path.basename(entry.name, ".md")),
          content,
          tags: tagsFor(content),
          links: linksFor(content),
          sourceUri: canonicalKey,
          contentHash: sha256(content),
          updatedAt: fileInfo.mtime.toISOString(),
        });
        stats.indexed += 1;
      } catch {
        stats.skippedUnreadable += 1;
      }
    }
  }

  await walk(root, true);
  documents.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  return { root, documents, stats };
}
