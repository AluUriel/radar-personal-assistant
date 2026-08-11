# Radar architecture

## Local connection control plane

The normal setup path does not use a populated `.env.local`. `radar:start` loads `%LOCALAPPDATA%\Radar\settings.json`, where secret fields are encrypted with Windows DPAPI for the current user. It then starts a Node loopback setup service before the web runtime. The browser can read redacted status and submit JSON changes only from Radar's exact local origin; the supervisor uses a separate random bearer secret. Neither path returns stored credential values.

The local setup service also owns native operating-system actions such as the Obsidian folder picker. The Cloudflare-style web runtime never receives filesystem permission or direct DPAPI access. Saved settings take effect after a Radar restart, and saving configuration never starts source ingestion by itself.

Provider authorization uses the system browser and loopback callbacks. Every attempt has a random, single-use state value with a ten-minute lifetime and a PKCE verifier kept only in broker memory. Gmail and Slack access is saved only after the provider profile exactly matches the configured owner email. Discord uses its MCP server's OAuth discovery and dynamic client registration, then retains the existing content-level owner verification. Rotating Slack and Discord tokens are refreshed and re-encrypted before a collector starts.

Radar is a single-user, read-first assistant for requests arriving through Slack, Gmail/Intercom, and Discord. The UI is intentionally separate from source credentials and from the text generator.

## Data flow

1. Source adapters read messages with least-privilege, read-only credentials.
2. A normalizer divides large histories into stable bounded records and uploads byte-bounded batches, then stores conversations and messages idempotently by source ID.
3. Triage detects the latest unresolved ask directed at the owner and scores impact, urgency, explicitness, blocking status, and age.
4. Every ingested source conversation becomes a canonical, provenance-preserving transcript and, when it contains a request, issue reference, or reported outcome, a separate deterministic issue-history record. Curated issues, decisions, and runbooks can be added through the same knowledge endpoint.
5. Retrieval selects a bounded set of evidence for one request.
6. A loopback-only text generator receives only a structured, bounded envelope. It calls one fixed model endpoint with `tools: []` and `store: false`; it has no source credentials, filesystem workflow, database access, or write capability.
7. The UI shows the editable draft and concise evidence excerpts. Full knowledge documents remain server-side, edits are preserved per request while navigating, and sending is deliberately out of scope until a separate review-and-send workflow is approved.

The local scheduler runs configured collectors sequentially on a bounded interval. A cycle cannot overlap itself, missing configurations are skipped without values, and a source failure does not suppress later sources. Message collectors still perform their own owner-identity check before source content is read. The Obsidian collector validates explicit scope approval before reading any note body.

## Priority model

Priority scoring is deterministic after signal extraction. Public-channel questions enter the queue only when they mention the owner or continue a thread in which the owner participated; DMs and email threads are inherently direct. A mention remains actionable when later context messages follow it. Customer impact, blockers, direct asks, today deadlines, mentions, approval requests, newer replies, and unresolved follow-ups add weight. FYIs, acknowledgement-only messages, and conversations already answered by the owner are excluded from the action queue. The stored rationale makes the score explainable and re-runnable when the scoring policy changes.

## Knowledge retrieval

Knowledge documents have stable canonical keys, content hashes, provenance URIs, and document kinds. Derived issue history preserves the current request, detected issue identifiers, attributed owner replies, and explicitly reported resolution evidence without claiming that an outcome was independently verified. Deleted source text is omitted. Retrieval currently ranks exact normalized term overlap with stronger weight for titles and canonical keys, plus small boosts for runbooks, decisions, and issues. This first method is local and auditable; semantic embeddings remain disabled until their privacy boundary and provider are explicitly approved.

## Prompt-injection boundary

- Source text and Obsidian documents are always untrusted data.
- Instructions live in a separate trusted policy; source content cannot override it.
- The generator receives `tools: []` and cannot call Slack, Gmail, Discord, Intercom, the database, or the filesystem.
- Retrieved text is length-bounded and serialized, never interpolated into system instructions.
- Output is plain draft text. The user must review it before any future write action.
- Every draft records its evidence IDs and safety-policy version for audit.
- Every application route is owner-gated in production. Collector writes additionally support a hashed bearer-secret comparison and bounded batches.
- The local sidecar authenticates Radar with a separate shared secret, binds only to `127.0.0.1`, never logs source bodies, and has no endpoint that can send or mutate source data.
- Its launcher passes only sidecar/OpenAI environment settings into a Node permission-restricted child. General filesystem reads, filesystem writes, child processes, workers, and native addons are denied. The UI reports the generator as restricted only after its health response proves those controls are active.

This boundary limits impact even if a message says “ignore previous instructions” or embeds fake tool calls. It does not make model output inherently trustworthy; evidence display and human review remain required.

## Source-specific rules

- Slack: paginate every accessible public channel, private channel, DM, group DM, history page, and thread with no default time or count cap; split storage into bounded parts, detect direct mentions and newer replies, and report permission or optional diagnostic limits honestly.
- Gmail: paginate every thread matching the configured complete-mailbox query, fetch inline or referenced text bodies, group by thread, and divide unusually long threads into bounded records. A positive diagnostic thread cap is reported as partial coverage.
- Intercom: treat notification emails as a view into a customer conversation, not as separate independent requests.
- Discord: reuse the existing read-only archive/MCP, verify the configured owner before channel reads, scan the complete history of every allowed channel by default with adaptive bounded windows, and report the missing deletion-tombstone contract as partial coverage.
- Obsidian: preserve provenance and user-authored prose; ingest only canonical notes selected by an approved path manifest, use byte-bounded uploads, and record partial coverage if safe indexing skips any selected file.

## Current implementation state

- Responsive prioritized inbox and response/evidence panel: implemented.
- Normalized database schema and source-adapter contract: implemented.
- Text-only safety envelope: implemented.
- Real Slack/Gmail credentials, verified Intercom query, Discord API credential, and approved Obsidian folder scope: pending external configuration.
- Deterministic triage, local retrieval, and continuously schedulable read-only Obsidian collector: implemented and tested with synthetic inputs; real note scope remains unapproved.
- Normalized conversation ingestion, idempotent message upserts, server-side priority scoring, coverage records, and inbox lifecycle updates: implemented and live-tested with synthetic payloads.
- Slack, Gmail/Intercom, and Discord collectors: implemented and tested with synthetic API responses; real ingestion remains identity-gated.
- Automatic source-conversation knowledge with provenance and bounded transcripts: implemented.
- Deterministic issue-history extraction with attributed, unverified resolution evidence and deleted-message omission: implemented and live-tested with a synthetic ingestion payload.
- Text-only draft endpoint, loopback-only generator sidecar, evidence audit, and UI regeneration: implemented; the OpenAI API key and shared local secret remain external configuration.
- Discord archive response contract: live-verified through read-only data tools; dedicated collector credentials and exact owner ID remain external configuration.
