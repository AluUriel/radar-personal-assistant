import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getChatGPTUser, requireChatGPTUser, type ChatGPTUser } from "../chatgpt-auth";

function expectedOwnerEmail() {
  return process.env.RADAR_OWNER_EMAIL?.trim().toLowerCase() ?? "";
}

async function isLocalDevelopmentRequest() {
  const incoming = await headers();
  const host = (incoming.get("host") ?? "").split(":")[0].toLowerCase();
  return process.env.NODE_ENV !== "production" && (host === "localhost" || host === "127.0.0.1");
}

export async function getRadarAuthorization(): Promise<{
  allowed: boolean;
  user: ChatGPTUser | null;
  reason?: "signin-required" | "owner-not-configured" | "wrong-owner";
}> {
  if (await isLocalDevelopmentRequest()) {
    return {
      allowed: true,
      user: { userId: "local-development", email: "local@radar", displayName: "Local owner", fullName: null },
    };
  }

  const user = await getChatGPTUser();
  if (!user) return { allowed: false, user: null, reason: "signin-required" };
  const expected = expectedOwnerEmail();
  if (!expected) return { allowed: false, user, reason: "owner-not-configured" };
  if (user.email.trim().toLowerCase() !== expected) return { allowed: false, user, reason: "wrong-owner" };
  return { allowed: true, user };
}

export async function requireRadarOwner(returnTo = "/") {
  const authorization = await getRadarAuthorization();
  if (authorization.allowed && authorization.user) return authorization.user;
  if (authorization.reason === "signin-required") return requireChatGPTUser(returnTo);
  redirect(`/not-authorized?reason=${authorization.reason ?? "wrong-owner"}`);
}
