#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { loadLocalSettingsEnvironment } from "./lib/local-settings.mjs";
import { restrictedSidecarArguments, restrictedSidecarEnvironment } from "./lib/sidecar-launch.mjs";
import {
  generatorLaunchPlan,
  initializeRadar,
  localRadarRuntime,
  radarIsReady,
  sourceWatcherLaunchPlan,
  waitForRadar,
  webArguments,
} from "./lib/radar-supervisor.mjs";

const environment = loadLocalSettingsEnvironment(process.env);
const runtime = localRadarRuntime(environment);
const generator = generatorLaunchPlan(environment);
const watcher = sourceWatcherLaunchPlan(environment);
const children = new Map();
let stopping = false;

function log(event, details = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

function launch(label, command, args, childEnvironment = environment) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  children.set(label, child);
  child.once("error", (error) => {
    log("radar-component-error", { component: label, message: error.message });
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(label);
    if (!stopping) {
      log("radar-component-exit", { component: label, code, signal });
      void shutdown(code || 1);
    }
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  await Promise.all([...children.values()].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  })));
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown(0));
}

try {
  if (await radarIsReady(runtime.origin)) {
    log("radar-component-reused", { component: "web", url: runtime.origin });
  } else {
    const web = launch("web", process.execPath, webArguments(runtime.port));
    await Promise.race([
      waitForRadar(runtime.origin),
      new Promise((_, reject) => web.once("exit", (code, signal) => reject(new Error(`Web process exited during startup with ${signal ?? code}`)))),
    ]);
  }
  await initializeRadar(runtime.origin, runtime.seedSyntheticDemo);
  log("radar-storage-ready", { seededSyntheticDemo: runtime.seedSyntheticDemo });

  if (generator.enabled) {
    const sidecarScript = path.resolve("sidecar/text-generator.mjs");
    launch(
      "restricted-generator",
      process.execPath,
      restrictedSidecarArguments(sidecarScript),
      restrictedSidecarEnvironment(environment),
    );
  } else {
    log("radar-component-skipped", { component: "restricted-generator", missing: generator.missing, issues: generator.issues });
  }

  if (watcher.enabled) {
    launch("source-sync", process.execPath, [path.resolve("scripts/sync-sources.mjs"), "--watch"]);
  } else {
    log("radar-component-skipped", { component: "source-sync", sources: watcher.skipped });
  }

  log("radar-ready", {
    url: runtime.origin,
    generator: generator.enabled ? "started" : "not-configured",
    sourceSync: watcher.enabled ? watcher.enabledSources : [],
  });
} catch (error) {
  log("radar-start-failed", { message: error instanceof Error ? error.message : "Unknown startup error" });
  await shutdown(1);
}
