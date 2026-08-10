"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { demoItems, type InboxItem, type Priority, type Source } from "../data/demo";
import { ConnectionsPanel } from "./ConnectionsPanel";

const sources: Array<Source | "All"> = ["All", "Slack", "Email", "Discord"];
const priorities: Priority[] = ["Now", "Today", "Waiting"];

interface ApiInboxItem {
  id: string;
  source: "slack" | "gmail" | "discord" | "intercom";
  priority: "now" | "today" | "waiting";
  score: number;
  title: string;
  location: string;
  participants: string[];
  requestSummary: string;
  rationale: string[];
  lastActivityAt: string;
  permalink: string | null;
  messages: Array<{ id: string; sender: string; senderIsUser: boolean; content: string; sentAt: string }>;
  draft: null | {
    body: string;
    evidence: Array<{ id: string; kind: string; title: string; content: string; sourceUri?: string | null }>;
  };
}

interface SourceSyncStatus {
  source: "slack" | "gmail" | "discord" | "intercom";
  status: "completed" | "partial" | "failed";
  coverageComplete: boolean;
  coverageDetail: string;
  completedAt: string;
}

interface GeneratorRuntime {
  available: boolean;
  restricted: boolean;
}

const sourceStatusLabels: Record<SourceSyncStatus["source"], string> = {
  slack: "Slack",
  gmail: "Gmail",
  discord: "Discord",
  intercom: "Intercom",
};

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "recent";
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function safeExternalUrl(value?: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function fromApi(item: ApiInboxItem): InboxItem {
  const source: Source = item.source === "slack" ? "Slack" : item.source === "discord" ? "Discord" : "Email";
  const priority: Priority = item.priority === "now" ? "Now" : item.priority === "today" ? "Today" : "Waiting";
  const sender = item.participants[0] ?? item.messages.find((message) => !message.senderIsUser)?.sender ?? "Request";
  const lastMessage = item.messages[item.messages.length - 1]?.content ?? item.requestSummary;
  return {
    id: item.id,
    source,
    priority,
    score: item.score,
    sender,
    location: item.location,
    time: relativeTime(item.lastActivityAt),
    title: item.title,
    excerpt: lastMessage,
    ask: item.requestSummary,
    why: item.rationale,
    messages: item.messages.map((message) => ({
      author: message.sender,
      time: new Date(message.sentAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      body: message.content,
      mine: message.senderIsUser,
    })),
    suggestion: item.draft?.body ?? "No draft has been generated for this request yet.",
    evidence: (item.draft?.evidence ?? []).map((evidence) => ({
      title: evidence.title,
      detail: evidence.content,
      kind: evidence.kind === "issue" ? "issue" : evidence.kind === "conversation" ? "conversation" : "decision",
      url: safeExternalUrl(evidence.sourceUri),
    })),
    permalink: safeExternalUrl(item.permalink),
  };
}

function SourceIcon({ source }: { source: Source }) {
  return <span className={`source-icon source-${source.toLowerCase()}`} aria-hidden="true">{source === "Slack" ? "S" : source === "Email" ? "@" : "D"}</span>;
}

function InboxCard({ item, active, onClick }: { item: InboxItem; active: boolean; onClick: () => void }) {
  return (
    <button className={`inbox-card ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <div className="card-topline">
        <SourceIcon source={item.source} />
        <span className="sender">{item.sender}</span>
        <span className="time">{item.time}</span>
      </div>
      <strong>{item.title}</strong>
      <p>{item.excerpt}</p>
      <div className="card-meta">
        <span>{item.location}</span>
        <span className={`score score-${item.priority === "Now" ? "hot" : "calm"}`}>{item.score}</span>
      </div>
    </button>
  );
}

export function InboxAssistant() {
  const [items, setItems] = useState<InboxItem[]>(demoItems);
  const [selectedId, setSelectedId] = useState(demoItems[0].id);
  const [source, setSource] = useState<Source | "All">("All");
  const [query, setQuery] = useState("");
  const [resolved, setResolved] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [dataMode, setDataMode] = useState<"loading" | "demo" | "synthetic-live" | "live">("loading");
  const [syncing, setSyncing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationMessage, setGenerationMessage] = useState("");
  const [sourceStatuses, setSourceStatuses] = useState<SourceSyncStatus[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [generatorRuntime, setGeneratorRuntime] = useState<GeneratorRuntime>({ available: false, restricted: false });

  const reloadInbox = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await fetch("/api/inbox", { cache: "no-store" });
      if (!response.ok) throw new Error("Inbox unavailable");
      const payload = await response.json() as { mode: string; synthetic?: boolean; items?: ApiInboxItem[] };
      if (payload.mode === "live" && payload.items?.length) {
        const liveItems = payload.items.map(fromApi);
        setItems(liveItems);
        setSelectedId((current) => liveItems.some((item) => item.id === current) ? current : liveItems[0].id);
        setDataMode(payload.synthetic ? "synthetic-live" : "live");
      } else {
        setDataMode("demo");
      }
      try {
        const sourceResponse = await fetch("/api/sources", { cache: "no-store" });
        if (sourceResponse.ok) {
          const sourcePayload = await sourceResponse.json() as { sources?: SourceSyncStatus[] };
          setSourceStatuses(sourcePayload.sources ?? []);
        }
      } catch {
        // Coverage telemetry is informative and must not downgrade a healthy inbox.
      }
      try {
        const readinessResponse = await fetch("/api/readiness", { cache: "no-store" });
        if (readinessResponse.ok) {
          const readinessPayload = await readinessResponse.json() as { generatorRuntime?: GeneratorRuntime };
          setGeneratorRuntime(readinessPayload.generatorRuntime ?? { available: false, restricted: false });
        }
      } catch {
        // Configuration guidance is optional and must not downgrade a healthy inbox.
      }
    } catch {
      setDataMode("demo");
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reloadInbox(); }, 0);
    return () => window.clearTimeout(timer);
  }, [reloadInbox]);

  const filtered = useMemo(() => items.filter((item) => {
    const sourceMatch = source === "All" || item.source === source;
    const text = `${item.title} ${item.sender} ${item.location} ${item.excerpt}`.toLowerCase();
    return sourceMatch && !resolved.includes(item.id) && text.includes(query.toLowerCase());
  }), [items, source, query, resolved]);

  const selected = items.find((item) => item.id === selectedId) ?? filtered[0] ?? items[0] ?? demoItems[0];
  const visibleCount = filtered.length;
  const draftText = draftEdits[selected.id] ?? selected.suggestion;

  async function copyDraft() {
    await navigator.clipboard.writeText(draftText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function resolveSelected() {
    if (dataMode === "live" || dataMode === "synthetic-live") {
      const response = await fetch(`/api/inbox/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      if (!response.ok) return;
    }
    setResolved((items) => [...items, selected.id]);
    const next = filtered.find((item) => item.id !== selected.id);
    if (next) setSelectedId(next.id);
  }

  async function regenerateDraft() {
    if (dataMode !== "live" && dataMode !== "synthetic-live") {
      setGenerationMessage("Connect storage before generating a draft.");
      return;
    }
    setGenerating(true);
    setGenerationMessage("");
    try {
      const response = await fetch(`/api/draft/${encodeURIComponent(selected.id)}`, { method: "POST" });
      const payload = await response.json() as {
        error?: string;
        draft?: { body: string };
        evidence?: Array<{ id: string; kind: string; title: string; content: string; sourceUri?: string | null }>;
      };
      if (response.status === 503 && payload.error === "text-generator-disabled") {
        setGenerationMessage("The generator is not configured. The current draft was not changed.");
        return;
      }
      if (!response.ok || !payload.draft) throw new Error(payload.error ?? "Draft generation failed");
      setItems((current) => current.map((item) => item.id === selected.id ? {
        ...item,
        suggestion: payload.draft!.body,
        evidence: (payload.evidence ?? []).map((evidence) => ({
          title: evidence.title,
          detail: evidence.content,
          kind: evidence.kind === "issue" ? "issue" : evidence.kind === "conversation" ? "conversation" : "decision",
          url: safeExternalUrl(evidence.sourceUri),
        })),
      } : item));
      setDraftEdits((current) => ({ ...current, [selected.id]: payload.draft!.body }));
      setGenerationMessage("Draft updated in the isolated environment.");
    } catch {
      setGenerationMessage("The draft could not be generated. The current draft was not changed.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <p className="eyebrow">RADAR</p>
            <h1>What needs your attention</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className={`safe-pill ${generatorRuntime.restricted ? "" : "safe-pill-offline"}`}><i /> {generatorRuntime.restricted ? "Restricted generator" : generatorRuntime.available ? "Generator available" : "Generator offline"}</span>
          <button className="icon-button" aria-label="Connection settings" aria-expanded={showSetup} onClick={() => setShowSetup((value) => !value)}>•••</button>
          <div className="avatar">AP</div>
        </div>
      </header>

      {showSetup && <ConnectionsPanel />}

      <section className="toolbar" aria-label="Inbox filters">
        <div className="source-tabs">
          {sources.map((value) => (
            <button key={value} className={source === value ? "selected" : ""} onClick={() => setSource(value)}>
              {value}{value === "All" && <span>{visibleCount}</span>}
            </button>
          ))}
        </div>
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people, projects, or topics" />
        </label>
        <button className="sync-button" onClick={() => void reloadInbox()} disabled={syncing}><span>↻</span> {syncing ? "Reading…" : "Refresh"}</button>
      </section>

      <div className="workspace">
        <section className="inbox-pane" aria-label="Prioritized requests">
          <div className="pane-intro">
            <div><span className="live-dot" /> TODAY</div>
            <p>Sorted by impact, urgency, and whether someone is waiting on you.</p>
          </div>
          {priorities.map((priority) => {
            const items = filtered.filter((item) => item.priority === priority);
            if (!items.length) return null;
            return (
              <div className="priority-group" key={priority}>
                <div className="priority-heading"><span>{priority}</span><b>{items.length}</b><i /></div>
                {items.map((item) => (
                  <InboxCard key={item.id} item={item} active={selected.id === item.id} onClick={() => setSelectedId(item.id)} />
                ))}
              </div>
            );
          })}
          {!filtered.length && <div className="empty-state"><span>✓</span><strong>All clear</strong><p>No requests remain in this view.</p></div>}
        </section>

        <section className="detail-pane" aria-label="Request detail and suggested reply">
          <div className="detail-head">
            <div className="detail-origin"><SourceIcon source={selected.source} /><span>{selected.location}</span><span>·</span><span>{selected.time}</span></div>
            <button className="open-original" disabled={!selected.permalink} onClick={() => selected.permalink && window.open(selected.permalink, "_blank", "noopener,noreferrer")}>Open original ↗</button>
          </div>

          <article className="request-card">
            <div className="request-title"><div className="person-avatar">{selected.sender.split(" ").map((word) => word[0]).slice(0, 2).join("")}</div><div><span>{selected.sender}</span><h2>{selected.title}</h2></div></div>
            <div className="message-stack">
              {selected.messages.map((message, index) => (
                <div className={`message ${message.mine ? "mine" : ""}`} key={`${message.time}-${index}`}>
                  <div><strong>{message.author}</strong><span>{message.time}</span></div><p>{message.body}</p>
                </div>
              ))}
            </div>
            <div className="ask-summary"><span>WHAT THEY NEED FROM YOU</span><p>{selected.ask}</p></div>
            <div className="reason-row">{selected.why.map((reason) => <span key={reason}>✓ {reason}</span>)}</div>
          </article>

          <article className="draft-card">
            <div className="draft-heading">
              <div><span className="spark">✦</span><div><p>SUGGESTED DRAFT</p><span>Based on {selected.evidence.length} knowledge sources</span></div></div>
              <button onClick={() => void regenerateDraft()} disabled={generating}>{generating ? "Generating…" : "Regenerate"}</button>
            </div>
            <textarea aria-label="Reply draft" value={draftText} onChange={(event) => setDraftEdits((current) => ({ ...current, [selected.id]: event.target.value }))} />
            {generationMessage && <p role="status" className="generation-status">{generationMessage}</p>}
            <div className="draft-actions">
              <button className="primary" onClick={copyDraft}>{copied ? "Copied ✓" : "Copy reply"}</button>
              <button onClick={() => document.querySelector<HTMLTextAreaElement>(".draft-card textarea")?.focus()}>Edit</button>
              <button className="resolve" onClick={() => void resolveSelected()}>Mark resolved</button>
            </div>
          </article>

          <article className="evidence-card">
            <div className="evidence-title"><div><span>◎</span><strong>Context used</strong></div><span className="untrusted">UNTRUSTED DATA</span></div>
            <div className="evidence-list">
              {selected.evidence.map((evidence) => (
                <button key={evidence.title} disabled={!evidence.url} onClick={() => evidence.url && window.open(evidence.url, "_blank", "noopener,noreferrer")}><span className={`evidence-kind evidence-${evidence.kind}`}>{evidence.kind === "issue" ? "#" : evidence.kind === "decision" ? "◆" : "↗"}</span><div><strong>{evidence.title}</strong><p>{evidence.detail}</p></div><i>›</i></button>
              ))}
            </div>
            <details className="safety-details">
              <summary>How this reply was protected</summary>
              <p>Messages and documents were treated as data, not instructions. The generator has no tools, credentials, or ability to send replies.</p>
            </details>
          </article>
        </section>
      </div>
      <div className="demo-banner">
        <div>{dataMode === "live" ? <><span>Connected data</span> · Persistence is active.</> :
          dataMode === "synthetic-live" ? <><span>Local storage active</span> · Records are still synthetic.</> :
            dataMode === "loading" ? <><span>Preparing Radar</span> · Reading local storage.</> :
              <><span>Demo view</span> · Real sources are not connected yet.</>}</div>
        <div className="source-health" aria-label="Source sync coverage">
          {(Object.keys(sourceStatusLabels) as SourceSyncStatus["source"][]).map((sourceName) => {
            const state = sourceStatuses.find((item) => item.source === sourceName);
            const label = state?.coverageComplete ? "complete" : state ? state.status : "not synced";
            return <span key={sourceName} className={`source-state source-state-${state?.coverageComplete ? "complete" : state ? "partial" : "missing"}`} title={state?.coverageDetail}>{sourceStatusLabels[sourceName]}: {label}</span>;
          })}
        </div>
      </div>
    </main>
  );
}
