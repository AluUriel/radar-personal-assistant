#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { restrictedSidecarArguments, restrictedSidecarEnvironment } from "./lib/sidecar-launch.mjs";

const script = path.resolve("sidecar/text-generator.mjs");
const child = spawn(process.execPath, restrictedSidecarArguments(script), {
  cwd: process.cwd(),
  env: restrictedSidecarEnvironment(process.env),
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`The restricted sidecar could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

