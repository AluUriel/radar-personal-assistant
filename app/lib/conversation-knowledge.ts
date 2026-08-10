export interface SourceMessage {
  sender: string;
  senderIsOwner?: boolean;
  content: string;
  sentAt: string;
  contentHash: string;
  deleted?: boolean;
}

export interface SourceConversation {
  source: "slack" | "gmail" | "discord" | "intercom";
  externalId: string;
  title: string;
  location: string;
  participantNames: string[];
  permalink?: string;
  updatedAt: string;
  messages: SourceMessage[];
}

const MAX_CONTENT = 500_000;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildConversationKnowledge(conversation: SourceConversation) {
  const header = [
    "UNTRUSTED SOURCE CONVERSATION",
    `Source: ${conversation.source}`,
    `Location: ${conversation.location}`,
    `Participants: ${conversation.participantNames.join(", ") || "Unknown"}`,
    `Last updated: ${new Date(conversation.updatedAt).toISOString()}`,
    "",
    "Transcript:",
  ].join("\n");
  let content = header;
  let omitted = 0;
  for (const message of conversation.messages) {
    if (message.deleted) {
      const tombstone = `\n[${new Date(message.sentAt).toISOString()}] [deleted message omitted]`;
      if (content.length + tombstone.length <= MAX_CONTENT - 120) content += tombstone;
      continue;
    }
    const entry = `\n[${new Date(message.sentAt).toISOString()}] ${message.sender}${message.senderIsOwner ? " (owner)" : ""}: ${message.content}`;
    if (content.length + entry.length > MAX_CONTENT - 120) {
      omitted += 1;
      continue;
    }
    content += entry;
  }
  if (omitted) content += `\n\n[${omitted} oversized transcript entries omitted]`;

  const canonicalKey = `source-conversation:${conversation.source}:${conversation.externalId}`;
  const identityHash = await sha256(canonicalKey);
  return {
    id: `source:${identityHash}`,
    canonicalKey,
    kind: "conversation" as const,
    title: conversation.title.slice(0, 500),
    content,
    sourceUri: conversation.permalink?.slice(0, 2_000) || null,
    contentHash: await sha256(content),
    updatedAt: new Date(conversation.updatedAt).toISOString(),
  };
}
