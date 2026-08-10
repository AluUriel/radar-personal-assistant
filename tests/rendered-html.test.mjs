import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/", authenticated = true) {
  process.env.RADAR_OWNER_EMAIL = "owner@example.com";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: "text/html",
        ...(authenticated ? {
          "oai-authenticated-user-id": "test-owner",
          "oai-authenticated-user-email": "owner@example.com",
        } : {}),
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the prioritized assistant inbox", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="en"/i);
  assert.match(html, /<title>Radar \| Your Meticulous inbox<\/title>/i);
  assert.match(html, /What needs your attention/);
  assert.match(html, /Generator offline/);
  assert.match(html, /Suggested draft/i);
  assert.match(html, /Context used/);
  assert.match(html, /Untrusted data/i);
  assert.match(html, /Preparing Radar/);
  assert.doesNotMatch(html, /Lo que necesita|Generador aislado|Borrador sugerido|Datos no confiables|Preparando Radar/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("requires sign-in outside local development", async () => {
  const response = await render("/", false);
  assert.ok(response.status === 302 || response.status === 307);
  assert.match(response.headers.get("location") ?? "", /^\/signin-with-chatgpt\?return_to=/);
});
