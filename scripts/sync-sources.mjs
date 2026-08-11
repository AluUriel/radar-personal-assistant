#!/usr/bin/env node
import process from "node:process";
import { createCollectorProcessRunner, runSourceSyncCycle, syncIntervalMilliseconds } from "./lib/source-sync.mjs";
import { loadLocalSettingsEnvironment } from "./lib/local-settings.mjs";
import { refreshOAuthAccessTokens } from "./lib/oauth-refresh.mjs";

const watch = process.argv.includes("--watch");
const requested = (process.env.RADAR_SYNC_SOURCES ?? "").split(",");
let cycleEnvironment = process.env;
const collectorRunner = createCollectorProcessRunner({ environment: () => cycleEnvironment });

async function cycle() {
  cycleEnvironment = loadLocalSettingsEnvironment(process.env, { preferStored: true });
  cycleEnvironment = await refreshOAuthAccessTokens(cycleEnvironment);
  const results = await runSourceSyncCycle({ environment: cycleEnvironment, requestedSources: requested, runCollector: collectorRunner.runCollector });
  console.log(JSON.stringify({ event: "radar-sync-cycle", completedAt: new Date().toISOString(), results }));
  return results;
}

process.once("SIGINT", collectorRunner.stop);
process.once("SIGTERM", collectorRunner.stop);

if (!watch) {
  const results = await cycle();
  if (!results.some((result) => result.status === "completed")) process.exitCode = 2;
  else if (results.some((result) => result.status === "failed")) process.exitCode = 1;
} else {
  const interval = syncIntervalMilliseconds(process.env);
  while (!collectorRunner.stopping) {
    await cycle();
    if (collectorRunner.stopping) break;
    await new Promise((resolve) => {
      let timer;
      function finish() {
        clearTimeout(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      }
      function stop() { finish(); }
      timer = setTimeout(finish, interval);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
}
