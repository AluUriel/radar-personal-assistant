import type { Metadata } from "next";
import { InboxAssistant } from "./components/InboxAssistant";
import { requireRadarOwner } from "./lib/radar-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Radar | Your Meticulous inbox",
  description: "Important requests from Slack, email, and Discord, with context and safe reply drafts.",
};

export default async function Home() {
  await requireRadarOwner("/");
  return <InboxAssistant />;
}
