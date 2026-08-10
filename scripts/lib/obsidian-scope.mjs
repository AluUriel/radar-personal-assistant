import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_EXCLUDES = new Set([".git", ".obsidian", ".trash", "node_modules", ".radar-data"]);

function normalizeRelativePath(value) {
  if (typeof value !== "string") throw new Error("Scope entries must be strings");
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe or overly broad Obsidian scope entry: ${value}`);
  }
  return normalized;
}

export function validateApprovedScope(payload) {
  if (!payload || payload.version !== 1) throw new Error("Obsidian scope version 1 is required");
  if (payload.approved !== true) throw new Error("Obsidian scope must be explicitly approved before indexing");
  if (!Array.isArray(payload.include) || !payload.include.length) throw new Error("Obsidian scope requires at least one included path");
  if (payload.exclude !== undefined && !Array.isArray(payload.exclude)) throw new Error("Obsidian scope exclude must be an array");
  return {
    include: Array.from(new Set(payload.include.map(normalizeRelativePath))),
    exclude: Array.from(new Set((payload.exclude ?? []).map(normalizeRelativePath))),
  };
}

export async function loadApprovedScope(scopePath) {
  const payload = JSON.parse(await readFile(path.resolve(scopePath), "utf8"));
  return validateApprovedScope(payload);
}

function matchesPath(relativePath, candidate) {
  return relativePath === candidate || relativePath.startsWith(`${candidate}/`);
}

export function scopeIncludesFile(relativePath, scope) {
  const normalized = relativePath.replaceAll("\\", "/");
  return scope.include.some((candidate) => matchesPath(normalized, candidate))
    && !scope.exclude.some((candidate) => matchesPath(normalized, candidate));
}

export function scopeMayContainFiles(relativeDirectory, scope) {
  const normalized = relativeDirectory.replaceAll("\\", "/");
  if (scope.exclude.some((candidate) => matchesPath(normalized, candidate))) return false;
  return scope.include.some((candidate) => matchesPath(normalized, candidate) || matchesPath(candidate, normalized));
}

async function countMarkdownMetadata(directory, root, stats) {
  if (directory !== root) {
    try {
      if (await lstat(path.join(directory, ".git"))) {
        stats.nestedRepositories += 1;
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        stats.unreadable += 1;
        return;
      }
    }
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    stats.unreadable += 1;
    return;
  }
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      stats.symlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await countMarkdownMetadata(fullPath, root, stats);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
      stats.markdownFiles += 1;
    }
  }
}

export async function inventoryObsidianScope(vaultPath) {
  const root = await realpath(path.resolve(vaultPath));
  if (!(await stat(root)).isDirectory()) throw new Error("Obsidian vault path must be a directory");
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (DEFAULT_EXCLUDES.has(entry.name) || entry.isSymbolicLink()) continue;
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
      candidates.push({ path: entry.name, type: "file", markdownFiles: 1, nestedRepositories: 0, symlinks: 0, unreadable: 0 });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const stats = { markdownFiles: 0, nestedRepositories: 0, symlinks: 0, unreadable: 0 };
    await countMarkdownMetadata(path.join(root, entry.name), root, stats);
    candidates.push({ path: entry.name, type: "directory", ...stats });
  }
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return { root, candidates };
}
