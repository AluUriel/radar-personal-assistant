const MAX_BATCH_BYTES = 4_500_000;

function payloadBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function makeKnowledgeBatches(documents, batchSize = 20, maxBatchBytes = MAX_BATCH_BYTES) {
  if (!documents.length) return [[]];
  const batches = [];
  let current = [];
  for (const document of documents) {
    const candidate = [...current, document];
    const bytes = payloadBytes({ documents: candidate });
    if (bytes > maxBatchBytes && !current.length) {
      throw new Error(`Knowledge document ${document.id || "unknown"} exceeds the safe ingestion size`);
    }
    if (current.length && (current.length >= batchSize || bytes > maxBatchBytes)) {
      batches.push(current);
      current = [document];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function uploadKnowledgeBatches({
  radarUrl,
  secret,
  documents,
  sourceSync,
  fetchImpl = fetch,
  batchSize = 20,
  maxBatchBytes = MAX_BATCH_BYTES,
}) {
  const endpoint = new URL("/api/ingest/knowledge", radarUrl).toString();
  const batches = makeKnowledgeBatches(documents, batchSize, maxBatchBytes);
  let uploaded = 0;

  for (const [index, batch] of batches.entries()) {
    const finalBatch = index === batches.length - 1;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ documents: batch, ...(finalBatch && sourceSync ? { sourceSync } : {}) }),
    });
    if (!response.ok) throw new Error(`Knowledge upload failed with HTTP ${response.status}`);
    const result = await response.json();
    uploaded += result.upserted ?? 0;
  }

  return { uploaded, batches: batches.length };
}
