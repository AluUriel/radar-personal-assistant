import { env } from "cloudflare:workers";
import { canIngest } from "../../../lib/ingest-auth";

export const dynamic = "force-dynamic";

type KnowledgeKind = "issue" | "decision" | "runbook" | "conversation" | "person" | "project" | "note";
interface IncomingDocument {
  id?: string;
  canonicalKey?: string;
  kind?: KnowledgeKind;
  title?: string;
  content?: string;
  sourceUri?: string;
  contentHash?: string;
  updatedAt?: string;
}

interface IncomingKnowledgeSync {
  id?: string;
  source?: "obsidian";
  startedAt?: string;
  completedAt?: string;
  documentCount?: number;
  coverage?: { complete?: boolean; detail?: string };
}

interface IncomingPayload {
  documents?: IncomingDocument[];
  sourceSync?: IncomingKnowledgeSync;
}

const allowedKinds = new Set<KnowledgeKind>(["issue", "decision", "runbook", "conversation", "person", "project", "note"]);

export async function POST(request: Request) {
  if (!(await canIngest(request))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 5_000_000) return Response.json({ error: "Batch is too large" }, { status: 413 });

  const payload = await request.json().catch(() => null) as IncomingPayload | null;
  if (!payload?.documents || !Array.isArray(payload.documents) || payload.documents.length > 25 || (!payload.documents.length && !payload.sourceSync)) {
    return Response.json({ error: "documents must contain up to 25 records, or an empty final source sync" }, { status: 400 });
  }

  const documents = payload.documents.map(validateDocument);
  const invalid = documents.find((document) => "error" in document);
  if (invalid && "error" in invalid) return Response.json({ error: invalid.error }, { status: 400 });

  const valid = documents.filter((document): document is Required<Pick<IncomingDocument, "id" | "canonicalKey" | "kind" | "title" | "content" | "contentHash" | "updatedAt">> & { sourceUri: string | null } => !("error" in document));
  const statements: D1PreparedStatement[] = valid.map((document) => env.DB.prepare(`
    INSERT INTO knowledge_documents (id, canonical_key, kind, title, content, source_uri, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_key) DO UPDATE SET
      kind=excluded.kind,
      title=excluded.title,
      content=excluded.content,
      source_uri=excluded.source_uri,
      content_hash=excluded.content_hash,
      updated_at=excluded.updated_at
  `).bind(document.id, document.canonicalKey, document.kind, document.title, document.content, document.sourceUri, document.contentHash, document.updatedAt));

  if (payload.sourceSync) {
    const syncError = validateKnowledgeSync(payload.sourceSync);
    if (syncError) return Response.json({ error: syncError }, { status: 400 });
    const sync = payload.sourceSync as Required<Pick<IncomingKnowledgeSync, "id" | "source" | "startedAt" | "completedAt" | "documentCount" | "coverage">>;
    statements.push(env.DB.prepare(`
      INSERT INTO source_sync_runs (id, source, status, coverage_complete, coverage_detail, cursor, conversations_count, messages_count, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        coverage_complete=excluded.coverage_complete,
        coverage_detail=excluded.coverage_detail,
        conversations_count=excluded.conversations_count,
        completed_at=excluded.completed_at
    `).bind(
      sync.id,
      sync.source,
      sync.coverage.complete ? "completed" : "partial",
      sync.coverage.complete ? 1 : 0,
      sync.coverage.detail!.slice(0, 2_000),
      sync.documentCount,
      new Date(sync.startedAt).toISOString(),
      new Date(sync.completedAt).toISOString(),
    ));
  }

  await env.DB.batch(statements);
  await env.DB.prepare("PRAGMA optimize").run();
  return Response.json({ upserted: valid.length, sourceSyncRecorded: Boolean(payload.sourceSync) }, { status: 202, headers: { "cache-control": "private, no-store" } });
}

function validateKnowledgeSync(sync: IncomingKnowledgeSync) {
  if (!sync.id || sync.id.length > 200) return "sourceSync requires a bounded id";
  if (sync.source !== "obsidian") return "Invalid knowledge source";
  if (!sync.startedAt || Number.isNaN(Date.parse(sync.startedAt))) return "Invalid sourceSync startedAt";
  if (!sync.completedAt || Number.isNaN(Date.parse(sync.completedAt))) return "Invalid sourceSync completedAt";
  if (!Number.isInteger(sync.documentCount) || sync.documentCount! < 0) return "Invalid sourceSync documentCount";
  if (!sync.coverage || typeof sync.coverage.complete !== "boolean" || !sync.coverage.detail) return "sourceSync coverage evidence is required";
  return null;
}

function validateDocument(document: IncomingDocument) {
  const canonicalKey = document.canonicalKey?.trim() ?? "";
  const title = document.title?.trim() ?? "";
  const content = document.content ?? "";
  if (!document.id || document.id.length > 160) return { error: "Each document requires a bounded id" } as const;
  if (!canonicalKey || canonicalKey.length > 1_000) return { error: "Each document requires a bounded canonicalKey" } as const;
  if (!document.kind || !allowedKinds.has(document.kind)) return { error: "Invalid knowledge kind" } as const;
  if (!title || title.length > 500) return { error: "Each document requires a bounded title" } as const;
  if (!content || content.length > 500_000) return { error: "Document content must be between 1 and 500000 characters" } as const;
  if (!document.contentHash || !/^[a-f0-9:]{8,200}$/i.test(document.contentHash)) return { error: "Invalid contentHash" } as const;
  const updatedAt = document.updatedAt && !Number.isNaN(Date.parse(document.updatedAt)) ? new Date(document.updatedAt).toISOString() : "";
  if (!updatedAt) return { error: "Invalid updatedAt" } as const;
  return { id: document.id, canonicalKey, kind: document.kind, title, content, sourceUri: document.sourceUri?.slice(0, 2_000) || null, contentHash: document.contentHash, updatedAt };
}
