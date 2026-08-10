#!/usr/bin/env node
import process from "node:process";
import { createLocalSetupServer } from "./lib/local-setup-server.mjs";

const host = "127.0.0.1";
const port = Number(process.env.RADAR_SETUP_PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("RADAR_SETUP_PORT must be a valid port");

const server = createLocalSetupServer();
server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "radar-local-setup-ready", url: `http://${host}:${port}` }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { process.exitCode = 0; }));
}
