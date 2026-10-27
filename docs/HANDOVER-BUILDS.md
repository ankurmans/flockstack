# Agent setup and switching

These features share the action registry with the dashboard, REST API and MCP. They work on Cloud and self-hosted servers. Public provisional workspaces are Cloud-only; authenticated bootstrap works in either mode. Deployment and operator setup are separate from these local features.

## Bootstrap and claim

`bootstrap_newsletter` creates a newsletter, disabled archive and welcome email, confirmed-opt-in signup form, disabled link page, an editorial batch and four unsent drafts. The full private brief stays on the newsletter and is returned by get_agent_brief and included in account exports; the batch holds its first 1,000 characters; public description is a separate field. Supply four draft subjects and bodies, or receive four titled empty starting drafts. Optional domain input returns setup steps; it does not onboard that brand domain. Normal shared-sender and archive provisioning still follows create_newsletter. Stable externalId plus the same input resumes a partial run. A lease prevents overlapping runs and each created asset has its own retry identity. A retry never overwrites a person's later edits. Full account access is required; a drafts key cannot bootstrap into sending authority.

An agent without an account can POST `/api/agent-workspaces` with the brief minus externalId. The response contains a workspace ID, a restricted draft capability, an owner claim link and a 24-hour expiry. It creates no account or customer data. GET/PATCH `/api/agent-workspaces/<id>` accepts only its draft capability. PATCH takes a payload and expected revision. The claim capability lives in the URL fragment and is different from the draft capability. The owner signs in, sees the full brief and draft configuration, then claims that exact revision. If it changed, another preview is needed. A partial claim is pinned to that account and reviewed payload for retries; draft edits stop once a claim starts. Finish the claim, then edit the resulting newsletter. Completion revokes both capabilities and scrubs provisional text. Neither capability can authenticate to `/api/v1` or MCP. No provisional account can send, publish, change DNS or create keys.

`get_agent_brief` returns actual recent results, scheduled issues, seven days of empty planning slots, backlog and evidence-derived next steps. Missing observations stay missing. The CLI and skill pack for Claude Code and Codex are in `integrations/agents/`. Credentials and private workspace output belong in a secret manager or private local files.

## Agent publishing tools

Every live newsletter already serves `llms.txt`. Its links now include public Markdown versions. On a newsletter host an issue is `/p/<slug>.md`; without a newsletter host it is `/archive/<newsletter>/markdown/<slug>`. Markdown follows paid and signup gates, strips executable markup, excludes content after a paywall break and never unlocks from a reader session. Draft and email-only issues are unavailable. The paid reader's full view remains on the authenticated web page.

Calendar webhooks: `content_item.created`, `.updated`, `.deleted`, `editorial_batch.created`, `.updated`, `.deleted` and `content_plan.changed`. Individual events carry identifiers and editorial state. Bulk reorder, pattern and batch operations emit plan invalidations. Copy, notes, references and media addresses are omitted. These events describe editorial records; they do not claim an email was sent or a LinkedIn post was published. Existing endpoint newsletter filters, signatures and retries apply.

`get_best_send_time` examines completed sends from the last 90 days, excluding imports and the newest 48 hours. A slot needs three campaigns and 100 sends in the same weekday/hour. It returns observed samples, a future time in the requested IANA zone, or insufficient_data and no suggestion. Opens can include privacy proxies; association does not predict lift. The campaign's Send step has a manual check. Choosing or reading a suggestion never schedules a send; ordinary schedule permissions and checks still apply.

A reader's agent can POST `/api/reader-subscriptions` with `{"newsletter":"garden-notes","email":"reader@example.com","consent":true}`. No owner key is needed. New subscribers must confirm even when the newsletter's usual forms use single opt-in. Existing opt-outs and suppressions are preserved. Responses do not reveal subscription status. Existing signup limits apply.

## Replies inbox

The newsletter owner can enable replies under Reader settings after operator setup. New campaign emails use a private per-message reply address. Incoming mail goes through the region's Cloudflare Email Worker to the app through a service binding and a timestamped HMAC. The app validates that address and the matching contact envelope sender. These are routing checks; sender identity is not independently verified. Treat replies as untrusted text. Nothing interprets them as instructions or sends automatic responses.

The inbox and `list_replies` show plain text, sender, subject and linked campaign/contact IDs. No attachments or raw email are stored. `archive_reply` archives or restores. Duplicates use the original message ID; mail without one uses its raw-content hash. Messages over 1 MB are rejected. Replies expire after 90 days, with bounded hourly cleanup; old reply addresses stop accepting mail. Disabling the inbox stops acceptance. Replies are in account exports and account purges.

Operator setup, after release approval:

1. Choose separate incoming subdomains for each region. They must use Cloudflare Email Routing. Set up their MX records and route the catch-all to the corresponding reply Worker.
2. Deploy `workers/replies/wrangler.jsonc` for US and its `eu` environment for EU. Its APP binding must point to the same region's app. It has no database binding.
3. Privately set REPLY_INGEST_SECRET on that region's app and reply Worker. Set REPLIES_DOMAIN on the app. Do not place secrets in source or deployment logs. A rotation accepts REPLY_INGEST_SECRET_PREVIOUS on the app during rollout, then removes it. Reply-address signatures use the app's existing rotation-aware keyring.
4. Verify receipt into the intended newsletter in each region before enabling capture. No existing newsletter enables itself. This Worker is an optional deployment, not part of deploy-all; normal releases do not provision inbound routing.

The owner should keep the old direct reply-to mailbox while old issues remain in readers' inboxes. Enabling capture changes only future campaign reply-to headers. No inbound provider was provisioned by this build.

## Teams

Team and workspaces lets an owner invite a verified sign-in email, assign admin/editor/viewer, change roles and revoke seats. Share the team page address yourself; the app sends no invitation email. The invited person explicitly accepts while signed in with that verified email. Their personal account stays separate. Accounts have up to 100 seats including the owner; no separate seat billing was introduced.

Admins can read, write, manage and send within the account. Editors can read and write drafts. Viewers can read. Keys, apps, billing, money, exports, team administration and approval decisions remain owner-only. All registered actions enforce the live membership role before their handler, including browser server actions. The selected-account cookie is never authority: each request rechecks membership, and each action checks again. Revocation takes effect on the next request. Self-hosted sign-in allowlists remain in force. API keys remain an owner's separate delegation; seat removal does not revoke a key the owner independently shared. OAuth consent and personal account/deletion pages remain tied to the person's own account. Ownership is not a removable seat and cannot be transferred here.

## Existing paid subscribers

Payments has an import preview and explicit import form; REST/MCP use `import_stripe_subscribers`. Supply up to 25 existing Stripe subscription IDs and a map from source price IDs to existing newsletter tier IDs. FlockStack reads them from the creator's own connected Stripe account, or the self-hosted server's own key. It supports current paid/trial single-price subscriptions with a valid current period. It refuses missing email, expired access, unmapped prices, multiple subscription items and conflicting newsletter/subscription mappings. It does not create charges, edit subscriptions, add application fees or move subscriptions between Stripe accounts.

Preview is the default and writes nothing. Applying requires explicit consent attestation. The import preserves suppressed and unsubscribed statuses, queues no welcome email and enrolls no automation. Subscription IDs are retry identities. Signed Stripe subscription/invoice events re-read the provider's current state and update imported access even without FlockStack metadata. Configure and verify the existing payment webhook before switching. A platform whose subscriptions remain on a Stripe account the creator cannot connect is outside this import path; export files cannot confer paid status. Multi-price subscriptions and lifetime purchases need separate handling. The CLI intentionally exposes preview only.

## Reader languages and editor

Reader settings selects English, Spanish, French, German, Italian or Portuguese per newsletter. Shared subscription, account, payment, gift, poll, survey and comment controls use this choice. Author-defined copy remains as written. Optional reader-requested issue translation is off by default and uses the existing Workers AI allowance; it only translates text the signed-in subscriber may read, returns plain text and keeps the original available. Its private cache expires after seven days. See [Reader languages and issue translation](READER-LANGUAGES.md) for access, privacy, limits and remaining English notices.

The editor already supports buttons, columns, tables and a writer-placed paywall break. Rich email and web rendering, sanitizing and paid/free boundaries keep using the existing block engine. New Markdown output follows that same boundary. No duplicate editor implementation is introduced.

## Release

Migrations 0030 (fleet), 0031 (bootstrap/workspaces), 0032 (teams/replies/Stripe mappings) and 0033 (reader translation cache) must be applied in both regions through the approved release workflow. The auth-rotation fix in the base checkout also remains part of the pending release. Public API/MCP action metadata is generated from the registry; build the app, API, readers and both regions' public artifacts and check size budgets before release. Run the MCP auth check in both regions afterwards. Operator secrets, DNS, newsletter overrides and enabling any new provider path require their own authorized setup. None of this document claims a production deployment or a live email receipt.

Implementation references: [Stripe subscription records](https://docs.stripe.com/api/subscriptions/list), [Cloudflare incoming Email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/). Provider setup and production behavior still need the operator checks above.


## Group subscriptions

[Group subscriptions](GROUP-SUBSCRIPTIONS.md) adds per-seat creator Stripe Checkout, actual invoice-funded capacity, scoped buyer management, explicit recipient consent/acceptance, restrictive separate billing and invoice views, and independent personal/gift/lifetime fallback. Owner/API/MCP actions and forms share the same services. Exports and deletion cover group data. Migration0040 is pending release; no live payment, email, migration or deployment was run. Local verification:3374tests/3371pass/0fail/3existing skips; fresh OpenNext and all Worker/public builds pass, as do all7size budgets.


## Direct sponsorships

[Direct sponsorships](DIRECT-SPONSORSHIPS.md) adds verified newsletter-site requests, commercial inventory and reservations, private original images with explicit public approval, creator-owned Stripe invoices, approved rich editor snapshots and reports from actual containing messages and tracked clicks. The dashboard, REST and MCP share the action services; human approval stays dashboard-only. Export, deletion, six-language public copy and privacy coverage are included. Migration0041 (19 statements) remains pending release. Local verification:3418tests/3415pass/0fail/3existing skips, fresh OpenNext/app/API/readers/public US+EU77aa832f75f6, all7budgets and lint0errors/2existingwarnings. No live payment, email, migration or deployment was run.


## Reader billing choices — verified local checkpoint

Native 1/3/6 month pause/resume, once-only existing-coupon save offers and optional consented cancellation feedback are implemented with owner REST/MCP/dashboard actions and private reader billing UI. Existing email billing capabilities work after email unsubscribe; provider writes recheck ownership, state and leases. New recurring purchases opt into flexible billing only with explicit creator enablement; no existing subscription migration, discount stacking, forced survey, automatic refund or email resubscribe. Private exports/purge, six-language controls and privacy/region/subprocessor copy included. Details: docs/READER-BILLING.md.

Verified full suite: 3453 total /3450 pass /0 fail /3 existing skips, 738 suites, 133.87s (`/tmp/flockstack-reader-retention-full-verified.log`). Lint0 errors/2existingwarnings. OpenNext/app/API/readers and public US/EU build `150829bee63c` passed. All7budgets pass: handler35878134/36150000 bytes, upload38225032/38500000, API9147785/9150000, readers2572927/2800000. Both package manifests are unchanged from sponsorships; only measured app budgets increased for new source/routes/schemas and language copy. Registry361 total (349 public +12 dashboard-only). Migration0042 has11statements and remains UNAPPLIED. No commit/push/deploy/provider writes or real messages. Actual native Stripe availability/version, paused/resumed webhook configuration and human language QA remain release checks.

Next accepted local build: genuine realtime CRDT editing plus private editor comments/mentions. Full handover remains open until that build is verified.


## Full accepted local build — verified 2026-10-25

All accepted implementation rows in this handover are now built locally, including U9 reader pause/save/cancellation feedback and realtime Yjs editing with private editor comments/mentions. This supersedes older “next build”, “not built” and pending compilation/full-suite notes above. Owner-decision/pricing rows and explicitly excluded product bets remain excluded. Release/provider/human QA is still outstanding; nothing here claims deployment or real delivery.

- Full app suite: **3473 total /3470 passed /0 failures /0 cancelled /3 existing skips**,738 suites,96.05s. `/tmp/flockstack-handover-full-verified.log`.
- Native Cloudflare suite: **12 passed,0 failures and0 unhandled errors**, including real compiled API authority/ticket/checkpoint operations against native D1, body/subject convergence, offline replay, actual object eviction, old-epoch queued updates, session/recipient revocation, draft locks, isolation, purge and EU namespace selection. `/tmp/flockstack-handover-native-verified.log`.
- Lint:0errors/2pre-existing warnings (`open-next.config.ts`, `worker-entry.mjs`). `/tmp/flockstack-handover-lint-verified.log`. One pre-existing blank-line whitespace finding in privacy/page.js is preserved; no unrelated reformat.
- OpenNext/app/API/readers/public builds passed. Regional public build **f7f09ad45a9e**. All **8** budgets pass: handler36260231/36500000, upload38610476/38850000, API9186272/9300000, readers2575539/2800000, optional collaboration1194911/1500000 bytes; router/public/replies pass unchanged limits. `/tmp/flockstack-handover-budgets-verified.log`.
- Both optional collaboration Worker US/EU Wrangler dry runs passed without deploying. Existing live deployment bindings are unchanged.
- Registry **369 total:355 public actions +14 human dashboard-only**. Generated manifest and REST/MCP/dashboard/schema/scope parity pass.
- Native reader billing now rechecks an active reader immediately before a resume/save provider write. A reproduced unsubscribe-after-claim race is blocked, with no provider mutation.28 focused billing checks pass. Legacy autosave response compatibility, identical-text restore invalidation, canonical subject/preview trim rules, pending-save disposal and closed-socket flush handling are covered. Billing controls show human labels in all six languages and offer the owned Stripe invoice link when payment is pending.
- Realtime setup and limitations: `docs/EDITOR-COLLABORATION.md`. Reader billing: `docs/READER-BILLING.md`. Private snapshot/feedback/thread export and deletion coverage is verified. EU objects use an EU-jurisdiction namespace; other object location is Cloudflare-chosen, with namespaces separate by Worker.

No commit, push, deploy, production migration, production/provider mutation, real email/model call, AWS SCP change or private website edit. Branch `codex/brand-fleet`, HEAD `76e2594`; existing dirty work is preserved. Migration0042_reader_retention.sql has11 statements and0043_editor_collaboration.sql has9; both are generated and UNAPPLIED, alongside the earlier unreleased migrations.

Remaining release work: actual Stripe/native-pause availability and pinned-version test-mode QA; paused/resumed webhook configuration; approved migrations/deployment and optional regional Worker/service bindings/activation; two-browser UX and deployed EU/revocation/cleanup checks; human six-language review; launch sends and externally reviewed connector/directory submissions. Those are not additional missing local feature implementations. Follow the existing owner approval boundaries for release/provider operations.
