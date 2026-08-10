import assert from "node:assert/strict";
import test from "node:test";
import {
  generatorLaunchPlan,
  initializeRadar,
  localRadarRuntime,
  radarIsReady,
  sourceWatcherLaunchPlan,
  waitForRadar,
  webArguments,
} from "../scripts/lib/radar-supervisor.mjs";

test("local supervisor derives the web port and rejects non-loopback targets", () => {
  assert.deepEqual(localRadarRuntime({ RADAR_URL: "http://127.0.0.1:3100", RADAR_SEED_SYNTHETIC_DEMO: "true" }), {
    origin: "http://127.0.0.1:3100",
    port: 3100,
    seedSyntheticDemo: true,
  });
  assert.throws(() => localRadarRuntime({ RADAR_URL: "https://radar.example.com" }), /loopback HTTP origin/);
  assert.deepEqual(webArguments(3100).slice(-3), ["dev", "--port", "3100"]);
});

test("generator starts only with a matching local restricted-sidecar configuration", () => {
  const valid = {
    TEXT_GENERATOR_URL: "http://127.0.0.1:8789/draft",
    TEXT_GENERATOR_API_KEY: "same",
    SIDECAR_SHARED_SECRET: "same",
    SIDECAR_PORT: "8789",
    OPENAI_API_KEY: "model-key",
    OPENAI_MODEL: "test-model",
  };
  assert.equal(generatorLaunchPlan(valid).enabled, true);
  assert.equal(generatorLaunchPlan({ ...valid, TEXT_GENERATOR_API_KEY: "different" }).enabled, false);
  assert.equal(generatorLaunchPlan({ ...valid, TEXT_GENERATOR_URL: "https://remote.example/draft" }).enabled, false);
});

test("source watcher starts only when at least one collector is fully configured", () => {
  assert.equal(sourceWatcherLaunchPlan({}).enabled, false);
  const plan = sourceWatcherLaunchPlan({
    RADAR_OWNER_EMAIL: "owner@example.com",
    RADAR_URL: "http://localhost:3000",
    RADAR_INGEST_SECRET: "secret",
    SLACK_ACCESS_TOKEN: "token",
  });
  assert.equal(plan.enabled, true);
  assert.deepEqual(plan.enabledSources, ["slack"]);
});

test("startup waits for HTTP readiness and initializes storage without leaking configuration", async () => {
  let attempts = 0;
  await waitForRadar("http://localhost:3000", {
    intervalMs: 0,
    timeoutMs: 100,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("not listening");
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(attempts, 2);

  let request;
  const result = await initializeRadar("http://localhost:3000", false, async (input, init) => {
    request = { input, init };
    return Response.json({ initialized: { tables: 6 } });
  });
  assert.equal(request.input, "http://localhost:3000/api/admin/initialize");
  assert.deepEqual(JSON.parse(request.init.body), { seedSyntheticDemo: false });
  assert.deepEqual(result, { initialized: { tables: 6 } });
});

test("startup can reuse a healthy existing local web process", async () => {
  assert.equal(await radarIsReady("http://localhost:3000", async () => new Response("{}", { status: 200 })), true);
  assert.equal(await radarIsReady("http://localhost:3000", async () => { throw new Error("offline"); }), false);
});
