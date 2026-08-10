interface GeneratorHealthPayload {
  ok?: boolean;
  mode?: string;
  tools?: boolean;
  storage?: boolean;
  runtime?: {
    enabled?: boolean;
    filesystemRead?: boolean;
    filesystemWrite?: boolean;
    childProcess?: boolean;
    worker?: boolean;
    nativeAddons?: boolean;
  };
}

export async function probeGeneratorHealth(endpoint: string | undefined, fetchImpl: typeof fetch = fetch) {
  if (!endpoint?.trim()) return { available: false, restricted: false };
  let url: URL;
  try {
    url = new URL(endpoint);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { available: false, restricted: false };
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
  } catch {
    return { available: false, restricted: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error", cache: "no-store" });
    if (!response.ok) return { available: false, restricted: false };
    const payload = await response.json() as GeneratorHealthPayload;
    const runtime = payload.runtime;
    const restricted = Boolean(
      payload.ok && payload.mode === "text-only" && payload.tools === false && payload.storage === false &&
      runtime?.enabled && runtime.filesystemRead === false && runtime.filesystemWrite === false &&
      runtime.childProcess === false && runtime.worker === false && runtime.nativeAddons === false,
    );
    return { available: Boolean(payload.ok), restricted };
  } catch {
    return { available: false, restricted: false };
  } finally {
    clearTimeout(timeout);
  }
}

