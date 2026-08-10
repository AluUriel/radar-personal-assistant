const MAX_BATCH_BYTES = 7_000_000;

function payloadBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function makeBatches(conversations, batchSize) {
  if (!conversations.length) return [[]];
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const conversation of conversations) {
    const bytes = payloadBytes(conversation) + 2;
    if (bytes > MAX_BATCH_BYTES) throw new Error(`Conversation ${conversation.id || "unknown"} exceeds the safe ingestion size`);
    if (current.length && (current.length >= batchSize || currentBytes + bytes > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(conversation);
    currentBytes += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function uploadConversationBatches({ radarUrl, secret, conversations, source, coverage, nextCursor, fetchImpl = fetch, batchSize = 20 }) {
  const endpoint = new URL("/api/ingest/conversations", radarUrl).toString();
  const startedAt = new Date().toISOString();
  let uploadedConversations = 0;
  let uploadedMessages = 0;

  const batches = makeBatches(conversations, batchSize);

  for (const [index, batch] of batches.entries()) {
    const completedAt = new Date().toISOString();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncRunId: `${source}:${startedAt}:${index}`,
        source,
        startedAt,
        completedAt,
        nextCursor,
        coverage,
        conversations: batch,
      }),
    });
    if (!response.ok) throw new Error(`Radar ingestion failed with HTTP ${response.status}`);
    const result = await response.json();
    uploadedConversations += result.upsertedConversations ?? 0;
    uploadedMessages += result.upsertedMessages ?? 0;
  }

  return { uploadedConversations, uploadedMessages };
}
