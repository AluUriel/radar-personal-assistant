# Source connection status

Verified on 2026-08-10. This is connection evidence, not a claim that ingestion is complete.

| Source | Current evidence | Gate before ingestion |
| --- | --- | --- |
| Slack | The connected profile resolves to `alu@fffuego.com`. | Reconnect the Meticulous Slack workspace/account and verify its identity and read scopes. No messages from the current connection were stored. |
| Gmail | The connector returns `UNAUTHORIZED` and requests reauthentication. | Reauthenticate the mailbox that receives `@meticuloushome.com` and Intercom traffic, then verify the returned profile. |
| Discord | Live read-only calls verified the archive contract and 30 currently allowed channels/threads; semantic search remains disabled. | Configure a dedicated backend-only archive key and the exact Discord owner user ID. Deletion tombstones remain an upstream coverage gap. |
| Obsidian | The local `Meticulous-SW` vault was inventoried using names and Markdown counts only; zero note bodies were read. The scheduler now has an approved-scope-only collector with byte-bounded upload and coverage reporting. | Review the generated scope proposal, select explicit included/excluded paths, then approve it before content indexing. |

No Slack messages, Gmail messages, Discord messages, or Obsidian note bodies have been copied into this project.

Run `npm run doctor` to inspect the current local configuration without printing or transmitting secret values. The same readiness results are available from the owner-only connection panel in Radar. Configuration presence does not replace identity or coverage verification.
