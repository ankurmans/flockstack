# Reader and web issue lifecycle events

Nine additional event types use the existing endpoint filters, regional routing, Standard Webhooks signatures, retry policy and delivery log. Their data contains `id`, `newsletterId` and, for comments/replies, the issue ID as `parentId`. It excludes comment/reply text, names, emails, moderation reasons, private rule examples and consent metadata. Read current state through the scoped API; a deleted record may no longer be readable.

| Type | When it is queued |
| --- | --- |
| `issue.published` | A first web publication, including web-only issues and short posts; email-only sends and resends are excluded |
| `issue.updated` | A successful published issue edit or restoration; sent emails keep their original content |
| `comment.created` | A new saved reader comment, including one held or hidden by rules |
| `comment.updated` | A successful reader edit, after its conflict checks |
| `comment.deleted` | The author deletes it, including an empty placeholder retained for replies |
| `comment.moderated` | A human changes a decision or its reason; an unchanged repeated decision emits nothing |
| `subscriber.deleted` | One contact is successfully deleted through the normal contact removal flow |
| `reply.received` | A new incoming plain-text reply is inserted; concurrent duplicate ingestion emits once |
| `reply_rules.updated` | The account owner saves Reply Rules settings |

Publication is distinct from email completion. `campaign.sent` keeps its existing meaning. No draft autosave event is added. Historical imports, bulk anonymization and whole-account purges do not produce these per-record notifications. Ordinary operation and hook queuing are not one database transaction: these events retain the existing best-effort creation and retry semantics, with no claim of an exactly-once outbox.

New queued payloads include a top-level `id` equal to the signed `webhook-id` header. It stays the same across delivery retries and manual redelivery. Separate same-millisecond changes have different IDs. Existing fields remain additive-compatible. The Zapier trigger now uses this ID for deduplication and retains the old timestamp fallback for older deployed payloads or synthetic samples. Make exposes the ID too. Receivers should deduplicate by event ID and fetch current state because notifications can arrive out of order.

All 51 event types are present in the local Zapier and Make catalogs. `integrations/SUBMISSION.md` and the generated source-hash inventory describe local validation and remaining provider review steps. A local package, runtime audit or schema validation is not a directory listing, provider execution test or real customer result.
