import { getRadarAuthorization } from "./radar-auth";

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result));
}

async function secureEqual(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function canIngest(request: Request) {
  const owner = await getRadarAuthorization();
  if (owner.allowed) return true;

  const expected = process.env.RADAR_INGEST_SECRET ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !provided) return false;
  return secureEqual(provided, expected);
}
