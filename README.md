# Radar

Radar is a private inbox assistant for one person. It consolidates requests from Slack, Gmail/Intercom, and Discord, ranks what needs attention, retrieves relevant knowledge, and prepares a reviewable reply draft.

All product UI, generated drafts, documentation, and configuration guidance are written in English. Original source messages remain verbatim so their meaning and provenance are not altered.

The current build is a working local application backed by D1/SQLite. It includes tested Slack, Gmail/Intercom, and Discord collectors, normalized ingestion, deterministic triage, automatic conversation and issue-history knowledge, local retrieval, and a capability-isolated draft endpoint. Real private messages remain disabled until each source identity is verified.

## Run locally

```powershell
npm install
Copy-Item .env.example .env.local
npm run doctor
npm run radar:start
```

Open `http://localhost:3000`.

`npm run radar:start` is the normal local entry point. It starts the web app (or reuses a healthy Radar instance already running at `RADAR_URL`), waits for it, initializes D1 idempotently, starts the permission-restricted generator only when all of its settings are valid, and starts the recurring sync watcher only when at least one source is fully configured. `Ctrl+C` shuts down every child process it started. It never seeds demo content unless `RADAR_SEED_SYNTHETIC_DEMO=true`; use `npm run dev` when you intentionally want only the web development server.

`.env.local` is ignored by Git. The web app, collectors, knowledge uploader, and isolated generator load it locally; secret values must never be committed. `npm run doctor` displays only missing setting names and local validation problems. A configured source is still treated as unverified until its collector confirms the exact owner identity and records scan coverage.

## Current capabilities

- Priority groups: Now, Today, and Waiting.
- Filters for Slack, Email, and Discord.
- Request detail, conversation context, and explicit priority reasons.
- Editable suggested reply whose per-request changes are preserved while navigating and copied exactly.
- Evidence panel showing concise excerpts and provenance for the knowledge supporting a draft; full private documents remain server-side.
- Visible prompt-injection boundary and human-review requirement.
- D1/SQLite schema for conversations, messages, inbox items, knowledge documents, and draft audit records.
- Deterministic priority scoring that removes FYIs, acknowledgements, and already-answered threads.
- Local evidence retrieval with title, canonical-key, and body matching.
- Read-only Obsidian indexer with provenance, hashing, size limits, and nested-repository protection.
- Protected, idempotent ingestion endpoints for knowledge and normalized conversations.
- Server-side priority calculation and source-sync coverage audit records.
- Private-owner authorization for the page and every read/write endpoint.
- Regenerable, audited drafts through a generic text-only sidecar endpoint.
- Automatic, provenance-preserving knowledge documents from every ingested source conversation.
- Deterministic issue histories containing issue references, current asks, owner replies, and explicitly reported resolution evidence.
- Private connection-readiness panel that exposes validation results but never secret values.
- One-shot and recurring synchronization for configured message sources and approved-scope Obsidian knowledge, without overlapping cycles.

## Safety model

Source content is untrusted. The generator contract in `app/lib/safe-draft.ts` bounds and serializes source data separately from trusted instructions. It declares no tools, network access, or writes, and produces draft text only. Source credentials belong in adapters or hosting secrets and must never reach the browser or model context.

See `ARCHITECTURE.md` for the full data flow and source-specific rules. See `SOURCE_STATUS.md` for the verified connection gates before real ingestion can begin.

## Index Obsidian safely

The indexer never writes inside the vault. First generate a metadata-only scope proposal. This reads folder names, file names, and Markdown counts, but zero note bodies:

```powershell
npm run scope:obsidian -- --vault "C:\path\to\vault" --out ".radar-data\obsidian-scope.proposed.json"
```

Review that file, copy it to the path configured by `OBSIDIAN_SCOPE_PATH`, add only explicit relative files or directories to `include`, add any narrower `exclude` paths, and change `approved` to `true`. A root-wide `.` entry, an empty scope, absolute paths, and parent traversal are rejected. Nested Git repositories remain excluded unless the approved invocation also uses `--include-nested-repos`.

Generated knowledge data must also go to an external, ignored location:

```powershell
npm run index:obsidian -- --vault "C:\path\to\vault" --scope ".radar-data\obsidian-scope.approved.json" --out ".radar-data\obsidian.ndjson"
```

Before reading each note body, the indexer verifies that its resolved path is inside the vault and explicitly included by the approved manifest. It also skips `.obsidian`, `.git`, Trash, dependencies, symbolic links, files over 2 MiB, and independent nested repositories. The metadata-only preview has been run against the real vault; content indexing has not.

The resulting NDJSON can be uploaded in byte-bounded batches after `RADAR_URL` and `RADAR_INGEST_SECRET` are configured:

```powershell
npm run upload:knowledge -- --in ".radar-data\obsidian.ndjson"
```

Secrets are read from the environment and are never placed in command output, browser code, model context, or the generated index.

After approval, `npm run collect:obsidian` performs indexing and upload in one read-only operation. It records complete or partial source coverage in Radar and is automatically included in `sync:sources`, `sync:watch`, and `radar:start`. An unapproved manifest stops the collector before any note body is read.

## Connect Slack, Gmail, and Discord

Copy `.env.example` to `.env.local`; do not commit populated values. Run `npm run doctor` after each setup change. Both collectors call a profile endpoint first and stop before reading content when the returned email does not equal `RADAR_OWNER_EMAIL`.

For Slack, use a reviewed read-only user token with access to the intended conversations. The collector needs identity/user lookup and the corresponding read/history scopes for public channels, private channels, DMs, and group DMs (`users:read`, `users:read.email`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, and `mpim:history`). It paginates every accessible channel, history page, and thread by default, with no lookback or count cap, and divides storage into bounded records. Optional positive `SLACK_LOOKBACK_DAYS`, `SLACK_MAX_CHANNELS`, or `SLACK_MAX_THREADS` values are diagnostic limits and make the recorded coverage partial. Run:

```powershell
npm run collect:slack
```

For Gmail, create OAuth credentials with `https://www.googleapis.com/auth/gmail.readonly`, store the refresh token only as a secret, and set `INTERCOM_GMAIL_QUERY` for the notification pattern used by the verified mailbox. By default, `GMAIL_QUERY` covers the complete mailbox except spam and trash, thread-list pages are exhausted, referenced text bodies are fetched, and long threads are divided into bounded records. Set a positive `GMAIL_MAX_THREADS` only for diagnostics; doing so marks coverage partial. Run:

```powershell
npm run collect:gmail
```

Each collector uploads normalized, byte-bounded batches to `RADAR_URL` using `RADAR_INGEST_SECRET` and records whether its scan was complete or partial. Slack rate limits or inaccessible conversations are reported as coverage gaps, never silently treated as a complete scan.

After configuring sources, run one complete cycle with:

```powershell
npm run sync:sources
```

For continuous local operation, keep this process running alongside Radar and the isolated generator:

```powershell
npm run sync:watch
```

`RADAR_SYNC_INTERVAL_MINUTES` defaults to 15 and is bounded between 1 minute and 24 hours. `RADAR_SYNC_SOURCES` can optionally restrict a cycle to `slack`, `gmail`, `discord`, or `obsidian`. Unconfigured sources are skipped with missing setting names only; one failed source does not prevent the others from completing, and secret values are never included in the scheduler result.

For Discord, Radar reuses the existing read-only archive. Set `DISCORD_MCP_URL`, its dedicated read-only API key, the exact `DISCORD_OWNER_USER_ID`, and a narrow `DISCORD_OWNER_QUERY` used to verify that identity before any channels are read. The collector searches the complete archive by default and adaptively splits busy time ranges so a 100-message API limit does not silently truncate history. Positive `DISCORD_LOOKBACK_DAYS` or `DISCORD_MAX_SEARCH_REQUESTS` values are optional diagnostic limits:

```powershell
npm run collect:discord
```

The current archive does not expose deletion tombstones, so Discord syncs are explicitly recorded as partial until that upstream contract is extended. Radar never treats an incomplete scan as complete.

## Configure draft generation

Radar includes a local-only sidecar that binds to `127.0.0.1`, accepts only the draft route, and sends stateless requests to the fixed OpenAI Responses API endpoint. Its launcher creates a Node permission-restricted child that receives only sidecar/OpenAI settings—not Slack, Gmail, Discord, Obsidian, or Radar credentials—and denies general filesystem reads, filesystem writes, child processes, workers, and native addons. It provides no model tools, storage, source credentials, or message-sending path.

Set `OPENAI_API_KEY`, generate one strong local shared secret, and place the same value in `SIDECAR_SHARED_SECRET` and `TEXT_GENERATOR_API_KEY`. Keep `TEXT_GENERATOR_URL=http://127.0.0.1:8789/draft`, then start the isolated process separately:

```powershell
npm run sidecar:text
```

The sidecar receives a trusted policy, separately serialized untrusted source data, and `capabilities: { tools: [], network: false, writes: false }`. It rejects any request that declares a capability, sends `tools: []` and `store: false` to the model, and returns draft text only. Its health response exposes the runtime restrictions as booleans, and Radar labels it “Restricted generator” only after verifying them. When the sidecar is unavailable, Radar preserves the current draft and displays “Generator offline.”

## Validation

```powershell
npm run lint
npm test
```
