import type { buildTextOnlyEnvelope } from "./safe-draft";

type TextEnvelope = ReturnType<typeof buildTextOnlyEnvelope>;

export async function generateTextOnlyDraft(envelope: TextEnvelope, fetchImpl: typeof fetch = fetch) {
  const endpoint = process.env.TEXT_GENERATOR_URL?.trim() ?? "";
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("TEXT_GENERATOR_URL must use HTTPS or local HTTP");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const apiKey = process.env.TEXT_GENERATOR_API_KEY?.trim();
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        task: "reply_draft",
        trusted_policy: envelope.instructions,
        untrusted_source_data: envelope.source_data,
        capabilities: envelope.capabilities,
        output: { format: "plain_text", maxCharacters: 8_000 },
        safetyVersion: envelope.safetyVersion,
      }),
    });
    if (!response.ok) throw new Error(`Text generator failed with HTTP ${response.status}`);
    const result = await response.json() as { text?: unknown; generator?: unknown };
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text || text.length > 8_000) throw new Error("Text generator returned an invalid draft");
    return { text, generator: typeof result.generator === "string" ? result.generator.slice(0, 200) : "text-only-sidecar" };
  } finally {
    clearTimeout(timeout);
  }
}
