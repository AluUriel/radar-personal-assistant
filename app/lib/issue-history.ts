import type { TriageSignals } from "./triage";
import type { SourceConversation, SourceMessage } from "./conversation-knowledge";

interface IssueHistoryConversation extends SourceConversation {
  request?: { summary?: string; signals?: TriageSignals; lastActivityAt?: string } | null;
}

const ISSUE_REFERENCE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,8}\b/g;
const RESOLUTION_EVIDENCE = /\b(resolved|fixed|root cause|workaround|solution|solved|confirmed working|deployed|released|shipped|restored|recovered)\b/i;
const NEGATED_RESOLUTION = /\b(not|is not|was not|isn't|wasn't|never|still not|not yet)\s+(resolved|fixed|solved|working|deployed|released|restored|recovered)\b/i;
const MAX_CONTENT = 120_000;
const MAX_EVIDENCE_MESSAGES = 12;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedExcerpt(value: string, limit = 2_000) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function isResolutionEvidence(message: SourceMessage) {
  return RESOLUTION_EVIDENCE.test(message.content) && !NEGATED_RESOLUTION.test(message.content);
}

function formatEvidence(message: SourceMessage) {
  return `- [${new Date(message.sentAt).toISOString()}] ${message.sender}${message.senderIsOwner ? " (owner)" : ""}: ${boundedExcerpt(message.content)}`;
}

export async function buildIssueHistoryKnowledge(conversation: IssueHistoryConversation) {
  const activeMessages = conversation.messages.filter((message) => !message.deleted);
  const searchableText = [conversation.title, conversation.request?.summary ?? "", ...activeMessages.map((message) => message.content)].join("\n");
  const issueReferences = Array.from(new Set(searchableText.match(ISSUE_REFERENCE) ?? [])).slice(0, 20);
  const resolutionMessages = activeMessages.filter(isResolutionEvidence).slice(-MAX_EVIDENCE_MESSAGES);
  const ownerMessages = activeMessages.filter((message) => message.senderIsOwner).slice(-3);
  const hasRequest = Boolean(conversation.request?.summary?.trim());

  if (!hasRequest && !issueReferences.length && !resolutionMessages.length) return null;

  const lines = [
    "UNTRUSTED DERIVED ISSUE HISTORY",
    "This record was extracted deterministically from source messages. Reported outcomes are evidence, not independently verified facts.",
    `Source: ${conversation.source}`,
    `Location: ${conversation.location}`,
    `Participants: ${conversation.participantNames.join(", ") || "Unknown"}`,
    `Source updated: ${new Date(conversation.updatedAt).toISOString()}`,
    `Issue references: ${issueReferences.join(", ") || "None detected"}`,
    "",
    "Current request:",
    hasRequest ? boundedExcerpt(conversation.request!.summary!) : "No explicit current request was detected.",
    "",
    "Reported resolution evidence:",
    ...(resolutionMessages.length ? resolutionMessages.map(formatEvidence) : ["No explicit resolution evidence was detected."]),
    "",
    "Recent owner response evidence:",
    ...(ownerMessages.length ? ownerMessages.map(formatEvidence) : ["No owner response was present in this source conversation."]),
  ];
  const content = lines.join("\n").slice(0, MAX_CONTENT);
  const canonicalKey = `source-issue-history:${conversation.source}:${conversation.externalId}`;
  const identityHash = await sha256(canonicalKey);
  const referencesMissingFromTitle = issueReferences.filter((reference) => !conversation.title.toUpperCase().includes(reference));
  const referencePrefix = referencesMissingFromTitle.length ? `${referencesMissingFromTitle.join(", ")} · ` : "";

  return {
    id: `issue-history:${identityHash}`,
    canonicalKey,
    kind: "issue" as const,
    title: `${referencePrefix}${conversation.title}`.slice(0, 500),
    content,
    sourceUri: conversation.permalink?.slice(0, 2_000) || null,
    contentHash: await sha256(content),
    updatedAt: new Date(conversation.updatedAt).toISOString(),
  };
}
