const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function setupEndpoint(pathname: string) {
  const raw = process.env.RADAR_SETUP_URL?.trim();
  const secret = process.env.RADAR_SETUP_SECRET?.trim();
  if (!raw || !secret) throw new Error("local-setup-unavailable");
  const url = new URL(pathname, raw);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error("local-setup-unavailable");
  return { url, secret };
}

export async function proxyLocalSetup(pathname: string, init: RequestInit = {}) {
  const { url, secret } = setupEndpoint(pathname);
  return fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${secret}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    cache: "no-store",
    redirect: "error",
  });
}

export async function sameOriginMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("content-type")?.startsWith("application/json") ?? false;
  try {
    return new URL(origin).origin === new URL(request.url).origin && (request.headers.get("content-type")?.startsWith("application/json") ?? false);
  } catch {
    return false;
  }
}
