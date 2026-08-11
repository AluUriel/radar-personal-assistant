# Radar

Radar is a private inbox assistant for one person. It consolidates requests from Slack, Gmail/Intercom, and Discord, ranks what needs attention, retrieves relevant knowledge, and prepares a reviewable reply draft.

All product UI, generated drafts, documentation, and configuration guidance are written in English. Original source messages remain verbatim so their meaning and provenance are not altered.

The current build is a working local application backed by D1/SQLite. It includes tested Slack, Gmail/Intercom, and Discord collectors, normalized ingestion, deterministic triage, automatic conversation and issue-history knowledge, local retrieval, and a capability-isolated draft endpoint. Real private messages remain disabled until each source identity is verified.

## Run locally

```powershell
npm install
npm run radar:start
```

Open `http://localhost:3000`.

`npm run radar:start` is the normal local entry point. It creates the local encrypted settings store, starts the Connections service and web app, initializes D1 idempotently, starts the permission-restricted generator only when all of its settings are valid, and starts recurring sync only when a source is fully configured. `Ctrl+C` shuts down every child process it started. It never seeds demo content unless `RADAR_SEED_SYNTHETIC_DEMO=true`; use `npm run dev` only when you intentionally do not need the Connections service.

Open the **Connections** panel from the top-right menu. Normal setup does not use `.env`: public configuration and DPAPI-encrypted secrets are stored in `%LOCALAPPDATA%\Radar\settings.json`, outside this repository and OneDrive. Encryption is bound to the current Windows user. The browser receives only non-secret fields and `stored` booleans, never credential values. `.env.example` remains available only for advanced runtime overrides.

A configured source is still treated as unverified until its collector confirms the exact owner identity and records scan coverage. Saving a connection does not read messages; finish every desired connection, restart Radar once, and review the planned first sync before authorizing ingestion.

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

## Connect Slack, Gmail, Discord, and Obsidian

Use the in-app **Connections** panel. It stores provider credentials through a loopback-only setup service protected by an ephemeral bearer secret and an exact-origin browser policy. Both Slack and Gmail collectors call a profile endpoint first and stop before reading content when the returned email does not equal the configured owner email.

For Slack, create one internal app from `config/slack-app-manifest.json`, enable PKCE if Slack does not apply the manifest setting automatically, and enter its public client ID in Connections. After that, **Authorize Slack** opens Slack, requests only the declared read scopes, verifies the approved email against the configured owner, and stores rotating tokens with Windows DPAPI. No token is copied manually. The collector paginates every accessible channel, history page, and thread by default, with no lookback or count cap, and divides storage into bounded records.

```powershell
npm run collect:slack
```

For Gmail, enable the Gmail API in a Google Cloud project and download one **Desktop app** OAuth client JSON. Import that file in Connections, then click **Authorize Gmail**. Radar uses PKCE and the Windows loopback callback, requests `https://www.googleapis.com/auth/gmail.readonly`, verifies the approved mailbox against the configured owner, and stores only the refresh token. Intercom remains a Gmail query rather than a duplicate mailbox integration.

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

For Discord, click **Authorize Discord**. The existing archive at `https://discord-knowledge-mvp-production.up.railway.app/mcp` publishes OAuth discovery, PKCE, dynamic client registration, and token refresh, so Radar registers itself and completes the entire flow automatically. No API key is copied. The collector still verifies the exact owner user ID and owner query before channels are read.

Authorization only grants and stores access. It does not read source messages or begin the first ingestion cycle; that remains a separate explicit approval gate.

```powershell
npm run collect:discord
```

The current archive does not expose deletion tombstones, so Discord syncs are explicitly recorded as partial until that upstream contract is extended. Radar never treats an incomplete scan as complete.

## Configure draft generation

Radar includes a local-only sidecar that binds to `127.0.0.1`, accepts only the draft route, and sends stateless requests to the fixed OpenAI Responses API endpoint. Its launcher creates a Node permission-restricted child that receives only sidecar/OpenAI settings—not Slack, Gmail, Discord, Obsidian, or Radar credentials—and denies general filesystem reads, filesystem writes, child processes, workers, and native addons. It provides no model tools, storage, source credentials, or message-sending path.

Enter an OpenAI API key and model in Connections; Radar generates and stores its own local sidecar secret. A ChatGPT subscription can authenticate ChatGPT and Codex, but it does not pay for ordinary OpenAI API requests. Radar does not copy or repurpose ChatGPT/Codex session tokens. This separation keeps the generator text-only and avoids granting a coding agent access to private messages.

After restarting Radar, the supervisor starts the isolated process automatically when generation is fully configured. It can also be started separately for diagnostics:

```powershell
npm run sidecar:text
```

The sidecar receives a trusted policy, separately serialized untrusted source data, and `capabilities: { tools: [], network: false, writes: false }`. It rejects any request that declares a capability, sends `tools: []` and `store: false` to the model, and returns draft text only. Its health response exposes the runtime restrictions as booleans, and Radar labels it “Restricted generator” only after verifying them. When the sidecar is unavailable, Radar preserves the current draft and displays “Generator offline.”

## Validation

```powershell
npm run lint
npm test
```
