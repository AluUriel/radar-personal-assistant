import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildIntegrationReadiness } from "../app/lib/readiness";
import { loadApprovedScope } from "./lib/obsidian-scope.mjs";

function parseEnvironmentFile(path: string) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const separator = trimmed.indexOf("=");
    if (separator < 1) return [];
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return [[name, value]];
  }));
}

function mergedEnvironment() {
  const fromDevVars = parseEnvironmentFile(resolve(".dev.vars"));
  const fromLocal = parseEnvironmentFile(resolve(".env.local"));
  return { ...fromDevVars, ...fromLocal, ...process.env };
}

const environment = mergedEnvironment();
const integrations = buildIntegrationReadiness(environment);
const vaultPath = environment.OBSIDIAN_VAULT_PATH?.trim();
let vaultAvailable = false;
try {
  vaultAvailable = Boolean(vaultPath && existsSync(vaultPath) && statSync(vaultPath).isDirectory());
} catch {
  vaultAvailable = false;
}
let scopeApproved = false;
let scopeIssue = "";
try {
  if (environment.OBSIDIAN_SCOPE_PATH?.trim()) {
    await loadApprovedScope(environment.OBSIDIAN_SCOPE_PATH.trim());
    scopeApproved = true;
  }
} catch (error) {
  scopeIssue = error instanceof Error ? error.message : "The Obsidian scope could not be validated.";
}

console.log("Radar setup doctor");
console.log("No secret values are displayed or sent anywhere.\n");

for (const integration of integrations) {
  const notes = [
    integration.missing.length ? `missing ${integration.missing.join(", ")}` : "",
    ...integration.issues,
    integration.id === "obsidian" && !vaultAvailable ? "OBSIDIAN_VAULT_PATH is not an accessible directory." : "",
    integration.id === "obsidian" && !scopeApproved ? (scopeIssue || "OBSIDIAN_SCOPE_PATH is not an approved scope manifest.") : "",
  ].filter(Boolean);
  const ready = integration.state === "configured" && !(integration.id === "obsidian" && (!vaultAvailable || !scopeApproved));
  console.log(`${ready ? "[configured]" : "[action required]"} ${integration.label}`);
  if (notes.length) console.log(`  ${notes.join(" ")}`);
  else console.log(`  ${integration.detail}`);
}

console.log("\nConfigured means settings are present and locally valid. Source identity and coverage are verified only by a successful collector sync.");

if (integrations.some((item) => item.state !== "configured") || !vaultAvailable || !scopeApproved) process.exitCode = 1;
