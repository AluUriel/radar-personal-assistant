export const collectorDefinitions = [
  {
    id: "slack",
    label: "Slack",
    script: "collectors/slack.mjs",
    required: ["SLACK_OWNER_EMAIL", "RADAR_URL", "RADAR_INGEST_SECRET", "SLACK_ACCESS_TOKEN"],
  },
  {
    id: "gmail",
    label: "Gmail and Intercom",
    script: "collectors/gmail.mjs",
    required: ["RADAR_OWNER_EMAIL", "RADAR_URL", "RADAR_INGEST_SECRET", "GMAIL_CLIENT_ID", "GMAIL_REFRESH_TOKEN"],
  },
  {
    id: "discord",
    label: "Discord",
    script: "collectors/discord.mjs",
    required: ["RADAR_URL", "RADAR_INGEST_SECRET", "DISCORD_MCP_URL", "DISCORD_MCP_API_KEY", "DISCORD_OWNER_USER_ID", "DISCORD_OWNER_QUERY"],
  },
  {
    id: "obsidian",
    label: "Obsidian",
    script: "collectors/obsidian.mjs",
    required: ["RADAR_URL", "RADAR_INGEST_SECRET", "OBSIDIAN_VAULT_PATH", "OBSIDIAN_SCOPE_PATH"],
  },
];

function hasValue(environment, name) {
  if (name === "SLACK_OWNER_EMAIL") {
    return Boolean((environment.SLACK_OWNER_EMAIL || environment.RADAR_OWNER_EMAIL)?.trim());
  }
  return Boolean(environment[name]?.trim());
}

export function planSourceSync(environment, requestedSources = []) {
  const requested = new Set(requestedSources.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return collectorDefinitions
    .filter((definition) => !requested.size || requested.has(definition.id))
    .map((definition) => {
      const missing = definition.required.filter((name) => !hasValue(environment, name));
      return { ...definition, enabled: missing.length === 0, missing };
    });
}

export async function runSourceSyncCycle({ environment, requestedSources = [], runCollector }) {
  const plan = planSourceSync(environment, requestedSources);
  const results = [];
  for (const collector of plan) {
    if (!collector.enabled) {
      results.push({ id: collector.id, status: "skipped", missing: collector.missing });
      continue;
    }
    const startedAt = new Date().toISOString();
    try {
      await runCollector(collector);
      results.push({ id: collector.id, status: "completed", startedAt, completedAt: new Date().toISOString() });
    } catch {
      results.push({ id: collector.id, status: "failed", startedAt, completedAt: new Date().toISOString() });
    }
  }
  return results;
}

export function syncIntervalMilliseconds(environment) {
  const minutes = Number(environment.RADAR_SYNC_INTERVAL_MINUTES || 15);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error("RADAR_SYNC_INTERVAL_MINUTES must be between 1 and 1440");
  }
  return Math.round(minutes * 60_000);
}

export function createCollectorProcessRunner({
  environment = process.env,
  cwd = process.cwd(),
  execPath = process.execPath,
  spawnImpl = spawn,
} = {}) {
  let stopping = false;
  let activeCollector = null;

  function runCollector(collector) {
    return new Promise((resolve, reject) => {
      if (stopping) {
        reject(new Error(`${collector.label} collector was cancelled before launch`));
        return;
      }
      const child = spawnImpl(execPath, [path.resolve(cwd, collector.script)], {
        cwd,
        env: typeof environment === "function" ? environment() : environment,
        stdio: "inherit",
        windowsHide: true,
      });
      activeCollector = child;
      child.once("error", (error) => {
        if (activeCollector === child) activeCollector = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (activeCollector === child) activeCollector = null;
        if (code === 0) resolve();
        else reject(new Error(`${collector.label} collector exited with ${signal ?? code}`));
      });
    });
  }

  function stop() {
    stopping = true;
    if (activeCollector && activeCollector.exitCode === null && activeCollector.signalCode === null) {
      activeCollector.kill("SIGTERM");
    }
  }

  return {
    runCollector,
    stop,
    get stopping() { return stopping; },
  };
}
import { spawn } from "node:child_process";
import path from "node:path";
