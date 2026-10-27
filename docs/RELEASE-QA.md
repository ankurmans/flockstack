# Release QA: what is left after the 2026-10-27 release

Runtime commit `6b846d6` is deployed to flockstack.io and eu.flockstack.io, with migrations 0030 to 0043 applied in both. What is checked: 3,473 app tests, 12 native collaboration tests, lint, builds, size budgets, and unauthenticated checks (home, sign-in, OpenAPI, OAuth metadata, the MCP challenge). What is not: any signed-in workflow, a send, a model call, a Stripe operation, or two browsers editing. The fake providers in the tests do not prove live behavior. This page is the rest, as steps.

Each step says who does it. **Owner terminal**: a shell where the owner holds the keys; values are typed at hidden prompts. **Owner browser**: a signed-in dashboard, or a reader's page. **Agent**: Claude Code or Codex in this repository, with no credentials; it can run what needs none and read output the owner pastes. No step here changes production by itself unless it says so; steps that do are marked **changes production**.

Nothing in this page needs a deploy except where it says so. Do not paste a key or a secret into a chat.

## 0. Before starting

1. **Owner browser.** On each region (`https://flockstack.io/api-keys`, `https://eu.flockstack.io/api-keys`) make a key named `release-qa` with level **Full access** (the admin reads in the smoke test, `get_billing`, `list_api_keys` and `list_team_members`, need it) or **Read only** (they are skipped). The EU key starts with `mc_eu_`. The key is shown once. Expect: a key in each region.
2. **Owner terminal.** `read -rs FLOCKSTACK_API_KEY && export FLOCKSTACK_API_KEY` and paste the key (nothing is echoed). Use the US key for step 1.1 and the EU key for 1.2. `unset FLOCKSTACK_API_KEY` between them.
3. When all of section 1 is done, revoke both keys on their API keys pages.

## 1. Smoke test of each region (a)

`scripts/smoke-live.mjs` sends GET requests to the REST API and `initialize`, `tools/list` and `tools/call` of read tools to `/mcp`, as the key. It checks status and the shape of each answer, never content, and prints a line with the time of each check. It cannot write: it refuses any method but GET, any path that is not a read in `lib/actions/manifest.js`, and any MCP tool that is not in the read scope class (`lib/action-scopes.js`) or that the server itself does not list as `readOnlyHint`. The key is only read from the environment, only sent as `Authorization` to the address given (https only, redirects are not followed) and never printed.

1. **Owner terminal.** `node scripts/smoke-live.mjs https://flockstack.io`. Expect: every line `ok`, then `All checks passed`. The `tools/list` line says `355 tools, expected 355` (the public actions of the registry; 369 with the 14 that are dashboard-only). Each `ok` line ends with `[api]` or `[app]`: which Worker answered, from `x-served-by`. `[api]` once the router's `API_ENABLED` says `all`, `[app]` before. A key whose account has no newsletter yet shows `skip` for the newsletter-scoped reads (reader settings, reply rules, mailing lists, authors, perks, creator match settings) with the reason, because the API answers 404 `Create a newsletter first`; the same 404 on an account that has a newsletter is a failure.
2. **Owner terminal.** `node scripts/smoke-live.mjs https://eu.flockstack.io` with the EU key. Expect: the same.
3. **Owner terminal.** `node scripts/check-mcp-auth.mjs https://flockstack.io` and the same for the EU address (no key needed). Expect: `All checks passed`.
4. **Agent.** `npm test -- tests/smoke-live.test.mjs` to see the test of the script itself. Expect: pass.

Reading a failure:

| Line | Meaning |
| --- | --- |
| `REST without a key ... 401` fails | The router or the API Worker answers an unauthenticated call with something else: look at `server-timing` and `x-served-by` with `curl -si`. |
| Every authenticated line `answered 401` | The key is for the other region (`mc_` is US, `mc_eu_` is EU) or was revoked. |
| One `REST GET /...` line `answered 500` or `503` | That feature's table or code is broken in production. The path names the action; the migration it needs is in the feature's page under docs. |
| `no <name> in the answer` | The answer changed shape. Compare `GET /api/v1/openapi.json`. |
| `tools/list`: `missing ...` or `not in this checkout` | The Worker serves another build than this checkout, or the key's level is not the one passed with `--level`. |
| `skip` lines | The key's level cannot run that action (a read only key skips `get_billing`, `list_api_keys` and `list_team_members`). Not a failure. |

A key with another level: `--level read_only` (or `drafts`, `send_with_approval`) says which tool count to expect.

## 2. Stripe test mode (b)

**Where.** flockstack.io and eu.flockstack.io run Stripe in live mode (Connect, with the creators' accounts). Test mode needs a stack with test keys, so run it on a local self-hosted server, which uses the same payment code with the owner's own Stripe key and writes to a local SQLite file. It never touches the production databases or live Stripe.

**Set up (owner terminal).**

1. `cp .env.example .env.local`, set `FLOCKSTACK_SQLITE=./local.db`, `BETTER_AUTH_SECRET`, `SUPPRESSION_HASH_KEY`, `ADMIN_EMAILS`, a Stripe **test** `STRIPE_SECRET_KEY` and `STRIPE_PAYMENTS_WEBHOOK_SECRET` (printed by the next command). Leave `FLOCKSTACK_CLOUD` unset. `npm run dev`. The sign-in code prints in the server console.
2. In a second terminal: `stripe listen --forward-to localhost:3000/api/webhooks/payments`. Use the `whsec_...` it prints as `STRIPE_PAYMENTS_WEBHOOK_SECRET`, restart the server.
3. Reader and sponsor emails (links to manage a group, a sponsorship, a reader's billing) are sent through SES or PostShiba. Without keys they cannot be read; give the local server the SES test keys and verified recipient addresses of the SES sandbox, or read the link from the database (`FLOCKSTACK_SQLITE`).

**Pinned Stripe API version.** `READER_RETENTION_VERSION = "2026-09-30.endive"` (`lib/reader-retention-rules.js`). When a newsletter has pauses enabled, new subscription Checkout Sessions are created with the `Stripe-Version: 2026-09-30.endive` header and `subscription_data.billing_mode = flexible`, and every call of `lib/reader-retention-store.js` (schedules, pauses, resumes, coupons, invoices) sends the same header. The account's default version is not changed. If Stripe does not know the version for the account, the first Checkout after enabling pauses fails: that is the test in 2.2. Native pause also needs the creator's Stripe account to support it; the page says so when it does not. Existing subscriptions are never migrated: a subscription with classic billing is managed in Stripe.

**Webhook events to add to the endpoint** (`/api/webhooks/payments`): `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.updated`; for Connect also `account.updated` and `account.application.deauthorized`. The README lists nine of these; the pause, resume and last four invoice events are handled by the code (`lib/payments/subscriptions.js`, `lib/sponsorship-payment-events.js`) and missing from it. `stripe listen` forwards all events, so the local test does not show a missing one; a live endpoint does (see 2.14).

**Stripe's test tools.** The repository's docs name no card or clock. Stripe's published test cards: `4242 4242 4242 4242` pays, `4000 0025 0000 3155` asks for 3-D Secure, `4000 0000 0000 0341` attaches but fails every later charge (use it for an unpaid renewal or resume invoice), `4000 0000 0000 9995` is declined for funds. Test clocks (Stripe Billing, Test clocks) only attach to a customer created with one. FlockStack's Checkout lets Stripe create the customer (`customer_email`), so a Checkout subscription cannot be moved forward in time. Where a step needs time (a pause at a paid boundary, an automatic resume, a trial end), either create the customer on a clock and the subscription through Stripe, then bring it in with `import_stripe_subscribers` (preview first; this path was not exercised), or end a trial now with `stripe subscriptions update <id> --trial-end=now` and update the billing cycle with Stripe's API. Say in the result which one was used.

**Steps (owner browser on the local server unless noted).**

1. Payments: connect nothing (the owner's key is used), create a tier with a monthly price, and in Stripe a 20 percent coupon `QA20` that is once-off with no trial. Expect: the paid page `/archive/<slug>/subscribe` offers the tier.
2. **Reader pause, save offers, cancellation feedback.** In **Reader billing** (`/reader-billing`) turn on pauses (all of 1, 3 and 6 months), confirm flexible billing, select the `QA20` coupon as the save offer, turn on the cancellation survey. Subscribe a test reader with `4242`. Expect: the Checkout works (no version error); the Stripe subscription shows billing mode `flexible`; `checkout.session.completed` and `customer.subscription.created` are answered 200 in `stripe listen`.
3. Open the "Manage your subscription" link in the paid reader's emails (`/api/shop/portal?token=...`): with the feature on it now opens `/reader/billing`, with no sign-in and no resubscribe, even after the reader unsubscribed from email. Expect: a private page with the pause, save offer and cancel controls; response headers `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex` (`curl -sI <link>`).
4. Choose a 1 month pause. Expect: state "Pause scheduled" with the paid period end; in Stripe a subscription schedule with a pause phase starting at that date; no discount, no collection pause, no changed `pause_collection`.
5. Cross the boundary (clock or the paths above). Expect: `customer.subscription.paused`, state "Subscription paused", no access given while paused; at the end of the pause `customer.subscription.resumed`, an invoice that pays, state "Subscription active".
6. Resume early. Expect: a prompt that acknowledges renewed billing; a resume invoice. With `4000 0000 0000 0341` as the card: the state stays "Resume awaiting payment", with a "Review invoice" link, and access stays paused. A second resume click does not make a second invoice.
7. Save offer: on a subscription with no discount, accept `QA20`. Expect: the coupon applies once. Accept again, or try on a subscription that already has a discount or promotion code: refused, nothing stacked.
8. Cancel. Expect: a survey if enabled, shown as optional; ending at the paid period end; the response in **Reader billing** (and `list_cancellation_responses`) only when the reader consented to share it, and the confirmation time set only after Stripe shows the cancellation. Delete the contact: the response is gone.
9. **Group seats invoices.** In **Manage groups** (`/group-subscriptions`) turn on groups. Buy 3 seats at `/reader/groups/buy?newsletter=<slug>` with `4242`. Expect: a group with 3 seats funded by the paid invoice (not by status alone); the buyer's management link (7 days) arrives; invite a reader, accept from their email with the checkbox, revoke, reassign. Raise the quantity in Stripe with the failing card `...0341`: capacity does not grow until an invoice is paid. Reduce the quantity: seats drop at once, the first positions stay. The management page lists the invoices from Stripe.
10. **Sponsorship invoices.** In **Sponsorships** (`/sponsorships`) turn on requests, add a placement type with a price and one open date. On `/archive/<slug>/sponsor` file a request, verify it from the email, accept it. **Create agreed invoice**. Expect: a Stripe draft then finalized `send_invoice` invoice with one item, not emailed; **Email current invoice to sponsor** is a separate click. Pay the invoice on Stripe's hosted page with `4242`: `invoice.paid` arrives and the booking shows paid. Approve the creative (owner only: a key cannot). In a rich draft use **Insert sponsor**; send the issue to a test list; open the report. Expect: one containing message, clicks counted only for real link clicks. Void an unpaid invoice: the date is released; cancel a paid one: it asks you to confirm there is no refund.
11. **Paid trial.** Create a `trial` offer with `trialDays: 14` and `trialAmountCents: 100`. Open its link. Expect: the page names the fee, the 14 days, the price and renewal; the button does not call it free. Pay with `4242`: the initial invoice is paid and the reader becomes paid; with `4000 0025 0000 3155` it asks for authentication first. An unpaid or mismatched initial invoice grants nothing. End the trial now (see test tools above): the recurring invoice is made. Cancel, then refund in Stripe: the refund does not cancel the subscription.
12. **Owner terminal** (once, at the end): keep the local database for a later look, or delete it. Revoke the Stripe test key if it was made for this.
13. **Agent.** Read what the owner pastes from `stripe listen` and the server log: every event answered 2xx, none `ignored: unknown account`.
14. **Owner browser, changes production.** When the local run is clean: in the live Stripe dashboard, edit the production payments webhook endpoint (US platform, EU platform) so it lists every event above. Without `customer.subscription.paused` and `.resumed` a pause done in Stripe is not seen; without the invoice events a voided sponsorship invoice is not seen.

## 3. Two browsers editing at once (c)

Needs the collaboration Worker provisioned and switched on (`docs/OPTIONAL-WORKERS-RUNBOOK.md`, part A). It cannot be tried on a `workers.dev` address: the Worker accepts only the dashboard's own origin.

1. **Owner browser.** Two different browsers (or profiles), signed in as the owner and as a team editor (a second user with an accepted seat), on the same rich-text draft. Press **Edit together and discuss privately** in both. Expect: both show the other's name and caret.
2. Type in both at once, in the subject, the preview and the body. Expect: both texts merge in order, no lost word.
3. Turn one browser offline (devtools), type, turn it back on. Expect: it reconnects and its edit merges; nothing was written to local storage (check Application, Local storage).
4. Select text, add a private thread, mention the other editor, reply, resolve; move the other browser to the quote. Expect: the quote locates the text after more edits; no email is sent and the thread is not on the public comments.
5. In a third tab edit the same draft with the ordinary editor, or restore a version. Expect: the shared editor stops with the local-copy control.
6. Schedule or send the draft from another tab. Expect: editing stops; the draft is locked.
7. Remove the editor's seat (**Team**). Expect: their editor closes within a minute; sign out in another tab of the same session: the same.
8. **Save and return to issue**. Expect: the draft shows the merged text and a checkpoint. **Account export**: `editor-collaboration.csv` and `editor-threads.csv` are in it.
9. **Owner terminal.** `npx wrangler tail flockstack-collaboration` during the steps. Expect: no thrown errors. Repeat 1 to 8 on eu.flockstack.io with `flockstack-collaboration-eu`.
10. Delete a test account that used the editor. Expect: it is not refused (a missing cleanup binding defers deletion with an error), and the room is purged.

## 4. Inbound replies (d)

Needs the replies Worker, Email Routing and the secrets (`docs/OPTIONAL-WORKERS-RUNBOOK.md`, part B).

1. **Owner terminal.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://flockstack.io/api/inbound-replies -d '{}'`. Expect: `401` (secret set, signature missing). `404` means `REPLY_INGEST_SECRET` is not set on the app.
2. **Owner browser.** Send a plain mail from a mailbox you own to `anything@<REPLIES_DOMAIN>`. Expect: it bounces with "Reply address not available" (the Worker reached the app and the app said no). Nothing is stored. `npx wrangler tail flockstack-replies` shows the call.
3. **Owner browser.** In **Reader settings** turn on the reply inbox for a test newsletter. Send an issue to a list holding only your own address. Expect: the email's `Reply-To` is `r-<id>-<signature>@<REPLIES_DOMAIN>` (view the headers). Old emails keep the direct reply-to.
4. Reply from that address. Expect: within a minute the text appears in **Replies** with sender, subject and the linked issue and contact; no attachment, no raw mail; no automatic answer is sent.
5. Reply again from the same message, then reply from another address. Expect: the same reply is not stored twice; one from a different address than the contact is refused.
6. Reply with an attachment over 1 MB. Expect: refused ("Replies must be under 1 MB").
7. Archive and restore a reply. Turn the reply inbox off: the next send carries the direct reply-to again.
8. Repeat 1 to 7 in the EU with its own domain and `flockstack-replies-eu`.

## 5. Translation, AI images, account assistant (e)

All three use the account's Workers AI daily allowance (one request per started model call; Free 5, Starter 20, Growth 60, Pro 150, Scale 300, Max 600 a day), `get_ai_usage` shows it. Failures and unusable output still count. Run them on a test account on a paid plan so the allowance is not 5, and run them from the owner's browser: they cannot be done with a key except `generate_image`.

1. **Translation.** **Owner browser:** in **Reader settings** turn on reader translations (shown only when the AI binding exists). As a signed-in test reader open a published issue, choose Spanish, press **Translate this issue**. Expect: a plain-text view in a few seconds, the original one click away, nothing in the email or the web issue changed. Look at: language, names and numbers kept, links not invented, nothing cut. Quality failure looks like: English left in the middle, a changed number or name, a summary instead of a translation, a refusal for a long issue (text over 12,000 characters is refused, not clipped), or a missing completion marker ("incomplete", refused). Check a free reader gets only the teaser of a paid issue. Do all six languages once; a second request for the same text is cached (no allowance used), the eleventh request in an hour is refused.
2. **AI image.** In the rich editor choose an image, **Generate image**, describe one picture, agree, generate. Expect: a preview, alt text asked for before insert, a JPEG in the media library labelled generated. Quality failure looks like: black or blank frame, a distorted subject, garbled text in the picture, a picture that ignores the prompt, a refusal ("unusable output", still counted). The eleventh attempt in an hour is refused. Do not put private words in the description.
3. **Account assistant.** Cmd+J (Ctrl+J) in the dashboard: create a **write drafts** grant, ask it to "list my last three issues", "make a draft titled QA test with two sentences" and "plan a LinkedIn post for next Tuesday". Expect: tool cards for what ran, a draft in **Campaigns**, a plan entry in the calendar, nothing sent. Ask it to send: on a drafts grant it must refuse; on **sends with approval** it must produce an approval on **Approvals** and nothing goes out until you decide. Quality failure looks like: prose that says it did something no tool card shows (the cards are the truth), a wrong tool, the same draft made twice in one turn, a long wait with no answer (at most three model calls and four tool attempts a turn), a turn that stops after a tool with an error card. Revoke the grant on **API keys** afterwards.
4. **Agent.** Read the usage the owner pastes from `get_ai_usage` before and after; each started call is one request.

## 6. Six-language copy review (f)

The reader catalog (`lib/reader-language-copy.js`) has 698 phrases in English, Spanish, French, German, Italian and Portuguese. The English phrase is the key. Authors' own words are never translated. No native speaker has read the other five.

1. **Agent.** `node scripts/export-locale-catalog.mjs --all --out-dir ../reader-review` writes `reader-catalog-es.csv`, `-fr`, `-de`, `-it` and `-pt` (698 rows each, UTF-8 with a byte order mark so a spreadsheet reads the accents). `--locale fr --out file.csv` makes one.
2. **Owner.** Give each reviewer their file. Tell them: edit only the `revised` column, and only for phrases that should change; empty keeps the current phrase. Never edit `key`. Keep every `{word}` exactly as it is (it is replaced by a name, a date, an amount); its place in the sentence is the reviewer's. The `note` column marks the few phrases identical to English. Use the same apostrophe the file uses. No markup.
3. **Agent.** For each returned file: `node scripts/import-locale-catalog.mjs reader-catalog-fr.csv`. Expect: `fr: N revised phrases of 698`. It fails (exit 1) on a changed key, a dropped, added or renamed placeholder, a stray brace, a line break, markup, a duplicated row, or a file made from an older catalog; it warns about long phrases and straight apostrophes. Nothing is written yet.
4. **Agent.** Send the failures back to the reviewer, or fix them by hand. When it passes: `node scripts/import-locale-catalog.mjs reader-catalog-fr.csv --write`. Only the lines of revised phrases change.
5. **Agent.** `npm test` (the reader language tests check every placeholder in every language), then commit. A deploy is the owner's step.
6. **Owner browser.** After the deploy look at the real pages in each language: set the newsletter language in **Reader settings** and read the subscribe, checkout, account and unsubscribe pages, the gift, poll and survey pages, and the pledge and billing emails. A phrase can be right alone and wrong in its page.

Not covered by the catalog and still English: some older billing notices and system errors, provider messages, and the dashboard.

## 7. EU region (g)

1. **Owner terminal.** `node scripts/smoke-live.mjs https://eu.flockstack.io` (section 1). Expect: the same count.
2. **Owner terminal.** Read-only: `npx wrangler d1 migrations list flockstack-eu --remote` and the same for `flockstack`. Expect: nothing pending; 0043 last in both.
3. **Owner browser.** Sign up a test account on eu.flockstack.io. Expect: sign-in works there, the cookie is `flockstack-eu.session_token`, the API key starts `mc_eu_`, and the same email is unknown at flockstack.io (an account lives in one region).
4. **Owner browser.** On an EU account: create a newsletter, upload an image, export the account. Expect: files in the `*-eu` buckets (`jurisdiction: eu`), not the US ones.
5. **Owner terminal.** `npx wrangler r2 bucket list` shows `flockstack-images-eu`, `flockstack-files-eu` and `flockstack-exports-eu`.
6. **Owner browser.** Send a test issue from an EU account to your own address. SES for the EU is `eu-west-1`; the organization's service control policy has denied SES outside the US regions before and the SES production access in `eu-west-1` is a separate request. Expect: the mail arrives. If it is refused with an access error, that is the policy or the SES sandbox, not the app.
7. Webhook events for an account the region does not have are acknowledged and logged at info level (`noteOtherRegion`), never alerted. Expect: no alert emails or Telegram messages from a Stripe, Polar or SES event sent to both regions.
8. AI features (translation, images, assistant, reply rules) run on Cloudflare's global network, so text may leave the EU. The privacy page and `lib/docs/regions.js` say so; read them once as an EU customer would. Say "data stored in the EU" or "EU-deployable", not "EU-resident".
9. Run section 3 and 4 against the EU Workers (`-eu` names) with its own `REPLIES_DOMAIN`.

## 8. Rollback commands (h)

Run from this repository. `--env eu` is the EU. Commands marked * change production; each takes effect in seconds and needs no deploy. Every one of them has a way back that is the same command with the opposite action.

**Router switches** (secrets of the router Worker; none set means everything goes to the app):

| What | Off | Back on |
| --- | --- | --- |
| API Worker (REST, MCP, OAuth) | `npx wrangler secret delete API_ENABLED --config workers/router/wrangler.jsonc [--env eu]` * | `echo all \| npx wrangler secret put API_ENABLED --config workers/router/wrangler.jsonc [--env eu]` (or a list: `wellknown,oauth,mcp,rest`) |
| API on `workers.dev` only | `... secret delete API_ENABLED_WORKERS_DEV ...` | `... secret put API_ENABLED_WORKERS_DEV ...` |
| Readers Worker | `npx wrangler secret delete READERS_ENABLED --config workers/router/wrangler.jsonc [--env eu]` * | `echo all \| ... secret put READERS_ENABLED ...` (or `beacons,tracking,unsubscribe,forms`) |
| Readers on `workers.dev` only | `... secret delete READERS_ENABLED_WORKERS_DEV ...` | `... secret put ...` |
| Newsletters' hosts through the router | `node scripts/route-archive-hosts.mjs --to app --apply` *, then `npx wrangler secret delete FLOCKSTACK_WORKER_NAME` on each app | `--to router --apply`, then put the router's name |

**Worker-side kill switches** (the Worker answers 503 `x-fs-api-unprocessed` or `x-fs-readers-unprocessed`, and the router asks the app):

| What | Off | Back on |
| --- | --- | --- |
| API Worker | `echo true \| npx wrangler secret put API_DISABLED --config workers/api/wrangler.jsonc [--env eu]` * | `npx wrangler secret delete API_DISABLED --config workers/api/wrangler.jsonc [--env eu]` |
| Readers Worker | `echo true \| npx wrangler secret put READERS_DISABLED --config workers/readers/wrangler.jsonc [--env eu]` * | `npx wrangler secret delete READERS_DISABLED --config workers/readers/wrangler.jsonc [--env eu]` |

**A bad version of a Worker** (`npx wrangler deployments list --config <config> [--env eu]` shows versions; `rollback` with no id goes to the one before):

| Worker | Command |
| --- | --- |
| App | `npx wrangler rollback [<version id>]` and `--env eu` for flockstack-eu |
| API | `npx wrangler rollback --config workers/api/wrangler.jsonc [--env eu]` |
| Readers | `npx wrangler rollback --config workers/readers/wrangler.jsonc [--env eu]` |
| Public pages | `npx wrangler rollback --config workers/public/wrangler.jsonc [--env eu]` |
| Router | `npx wrangler rollback --config workers/router/wrangler.jsonc --env us` (or `--env eu`) |
| Collaboration, replies | `npx wrangler rollback --config workers/collaboration/wrangler.jsonc [--env eu]`, `... workers/replies/wrangler.jsonc ...` |

Before the 2026-10-27 release each region's app was on its last version of 2026-10-24: `npx wrangler deployments list` (and `--env eu`) shows it; the private release report names the local files that hold the deployments and the Time Travel bookmarks from before the release. A Worker rollback does not undo a migration. Migrations 0030 to 0043 only create tables and indexes (no drop, alter, delete or update), so the old app runs on the new schema. D1 Time Travel exists (a bookmark was taken before the release for each database) but restores the whole database, losing everything written since: never as a first step.

**The router itself, or a domain:** give the domain back to the app (Workers & Pages, `flockstack`, Domains, add `flockstack.io`; `docs/ARCHITECTURE-WORKERS.md`, Rollback). The app has every route.

**Features** (what they gate; all keep existing data):

| Feature | Off |
| --- | --- |
| Reader pauses, save offers, feedback | **Reader billing**: turn each off (new uses stop; existing billing management stays) |
| Group purchases | **Manage groups**: turn off new purchases |
| Sponsorships | **Sponsorships**: turn off new requests |
| Paid trial fee | Turn the offer off (an open Checkout is not revoked) |
| Reader translation | **Reader settings**: turn off (cached answers are refused too) |
| Reply inbox | **Reader settings**: off; or `bash scripts/set-optional-worker-secrets.sh replies <us\|eu> --off` * |
| Reply Rules | The Reply Rules form on **Comments**: disable |
| Realtime editing | `bash scripts/set-optional-worker-secrets.sh collaboration <us\|eu> --off` *, then redeploy the collaboration Worker without `--var` |
| Account assistant | Revoke its grant on **API keys** |
| AI images | No switch other than removing the AI binding; revoke keys that can draft |
| Audio | `npx wrangler secret delete AUDIO_ENABLED [--env eu]` * |
| All sending | `echo false \| npx wrangler secret put SENDING_ENABLED [--env eu]` * (stops customers' sends in that region; sign-in codes go on) |
