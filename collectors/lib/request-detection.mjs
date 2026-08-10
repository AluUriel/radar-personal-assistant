const askPattern = /\?|\b(can you|could you|would you|please|need you to|please review|please confirm|puedes|podrías|por favor|necesito que|confirma|revisa|ayúdame|me ayudas)\b/i;
const customerPattern = /\b(customer|client|machine|refund|intercom|support|cliente|máquina|reembolso|soporte)\b/i;
const blockerPattern = /\b(blocked|blocking|urgent|down|cannot|can't|stuck|bloquead[oa]|urgente|caído|no puede|atascad[oa])\b/i;
const reviewPattern = /\b(review|approve|approval|sign off|merge|revisar|revisión|aprobar|aprobación)\b/i;
const todayPattern = /\b(today|asap|eod|end of day|hoy|cuanto antes|fin del día)\b/i;
const acknowledgementPattern = /^(thanks|thank you|thx|got it|ok|okay|perfect|great|gracias|entendido|listo|perfecto|genial|👍|✅)[.!\s]*$/i;

function substantive(message) {
  const text = (message.content ?? "").replace(/<[^>]+>/g, " ").trim();
  return text.length > 1 && !/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(text);
}

export function detectRequest(messages, { ownerId, ownerEmail, directConversation = false, threadConversation = false } = {}) {
  const ordered = [...messages].filter(substantive).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  if (!ordered.length) return null;
  const lastOwnerIndex = ordered.map((message) => Boolean(message.senderIsOwner)).lastIndexOf(true);
  const targetedIndexes = ordered.flatMap((message, index) => {
    if (message.senderIsOwner) return [];
    const content = message.content ?? "";
    const directMention = Boolean(ownerId && content.includes(`<@${ownerId}>`)) || Boolean(ownerEmail && content.toLowerCase().includes(ownerEmail.toLowerCase()));
    const followsOwnerInThread = threadConversation && ordered.slice(0, index).some((entry) => entry.senderIsOwner);
    return directConversation || directMention || followsOwnerInThread ? [index] : [];
  });
  const targetIndex = targetedIndexes.at(-1);
  if (targetIndex === undefined) return null;
  const candidate = ordered[targetIndex];
  const ownerAlreadyAnswered = lastOwnerIndex > targetIndex;

  const text = candidate.content.trim();
  const directMention = Boolean(ownerId && text.includes(`<@${ownerId}>`)) || Boolean(ownerEmail && text.toLowerCase().includes(ownerEmail.toLowerCase()));
  const explicitAsk = askPattern.test(text);
  const acknowledgementOnly = acknowledgementPattern.test(text);
  const newerRepliesAfterOwner = !ownerAlreadyAnswered && lastOwnerIndex >= 0 && targetIndex > lastOwnerIndex;

  return {
    summary: text.slice(0, 1_000),
    lastActivityAt: candidate.sentAt,
    signals: {
      explicitAsk,
      directMention,
      customerImpact: customerPattern.test(text),
      blocker: blockerPattern.test(text),
      approvalOrReview: reviewPattern.test(text),
      deadlineToday: todayPattern.test(text),
      newerRepliesAfterOwner,
      acknowledgementOnly,
      ownerAlreadyAnswered,
    },
  };
}
