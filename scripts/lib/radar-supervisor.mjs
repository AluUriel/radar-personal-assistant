import path from "node:path";
import { planSourceSync } from "./source-sync.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function configured(environment, name) {
  return Boolean(environment[name]?.trim());
}

export function localRadarRuntime(environment = process.env) {
  const rawUrl = environment.RADAR_URL?.trim() || "http://localhost:3000";
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("RADAR_URL must be a valid local HTTP URL");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("radar:start requires RADAR_URL to be a loopback HTTP origin such as http://localhost:3000");
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RADAR_URL must contain a valid local port");
  }
  return {
    origin: url.origin,
    port,
    seedSyntheticDemo: environment.RADAR_SEED_SYNTHETIC_DEMO?.trim().toLowerCase() === "true",
  };
}

export function generatorLaunchPlan(environment = process.env) {
  const required = ["TEXT_GENERATOR_URL", "TEXT_GENERATOR_API_KEY", "SIDECAR_SHARED_SECRET", "OPENAI_API_KEY", "OPENAI_MODEL"];
  const missing = required.filter((name) => !configured(environment, name));
  const issues = [];
  if (!missing.length && environment.TEXT_GENERATOR_API_KEY?.trim() !== environment.SIDECAR_SHARED_SECRET?.trim()) {
    issues.push("TEXT_GENERATOR_API_KEY and SIDECAR_SHARED_SECRET must match");
  }
  if (!missing.length) {
    try {
      const endpoint = new URL(environment.TEXT_GENERATOR_URL);
      if (endpoint.protocol !== "http:" || !LOOPBACK_HOSTS.has(endpoint.hostname) || endpoint.pathname !== "/draft") {
        issues.push("TEXT_GENERATOR_URL must be a loopback HTTP /draft endpoint");
      }
      const configuredPort = Number(environment.SIDECAR_PORT || 8789);
      const endpointPort = Number(endpoint.port || 80);
      if (configuredPort !== endpointPort) issues.push("TEXT_GENERATOR_URL and SIDECAR_PORT must use the same port");
    } catch {
      issues.push("TEXT_GENERATOR_URL must be a valid URL");
    }
  }
  return { enabled: missing.length === 0 && issues.length === 0, missing, issues };
}

export function sourceWatcherLaunchPlan(environment = process.env) {
  const requestedSources = (environment.RADAR_SYNC_SOURCES ?? "").split(",");
  const sources = planSourceSync(environment, requestedSources);
  return {
    enabled: sources.some((source) => source.enabled),
    enabledSources: sources.filter((source) => source.enabled).map((source) => source.id),
    skipped: sources.filter((source) => !source.enabled).map(({ id, missing }) => ({ id, missing })),
  };
}

export function webArguments(port) {
  return [path.resolve("node_modules/vinext/dist/cli.js"), "dev", "--port", String(port)];
}

export async function radarIsReady(origin, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${origin}/api/inbox`, { headers: { accept: "application/json" }, redirect: "error" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForRadar(origin, { fetchImpl = fetch, timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/api/inbox`, { headers: { accept: "application/json" }, redirect: "error" });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Radar did not become ready within ${timeoutMs}ms${lastError ? ` (${lastError.message})` : ""}`);
}

export async function initializeRadar(origin, seedSyntheticDemo, fetchImpl = fetch) {
  const response = await fetchImpl(`${origin}/api/admin/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ seedSyntheticDemo }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Radar storage initialization failed with HTTP ${response.status}`);
  return response.json();
}
