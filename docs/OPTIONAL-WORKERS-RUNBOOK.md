# Optional Workers: realtime editing and inbound replies

Two services are built and deployed nowhere. `node scripts/deploy-all.mjs` does not deploy either, no config of a Worker that runs today names them, and their switches are off. This page is how to provision each, region by region, US first and EU a day later. Nothing here has been run against production; the commands that change production are marked *. For what to look at afterwards see [release QA](RELEASE-QA.md), sections 3 and 4. For the design see [editor collaboration](EDITOR-COLLABORATION.md) and [reply rules](REPLY-RULES.md) (the inbox itself is in [handover builds](HANDOVER-BUILDS.md)).

Who does a step: **owner terminal** (a shell with the Cloudflare login; hidden prompts for values), **owner browser** (the Cloudflare dashboard or FlockStack), **agent** (Claude Code or Codex in this repository, no credentials).

## What was checked without touching anything

`npx wrangler deploy --dry-run --config <config> [--env eu] --outdir <folder>` compiles and stops before any upload. It was run for all four (collaboration and replies, US and EU) with an empty home folder and no `CLOUDFLARE_API_TOKEN`, so it had no Cloudflare session to write with, and it passed. Its one side effect is the collaboration Worker's build step (`npm run build:collaboration`), which writes `workers/collaboration/dist` (git-ignored).

| Worker | Upload | Bindings the dry run listed |
| --- | --- | --- |
| `flockstack-collaboration` | 1,167 KiB (gzip 294) | `ROOMS` Durable Object `CampaignRoom`; `AUTHORITY` to `flockstack-api#CollaborationAuthority`; `FLOCKSTACK_REGION` `us`, `APP_URL` `https://flockstack.io`, `COLLABORATION_ENABLED` `false` |
| `flockstack-collaboration-eu` | 1,167 KiB | the same, `AUTHORITY` to `flockstack-api-eu#CollaborationAuthority`, `eu`, `https://eu.flockstack.io` |
| `flockstack-replies` | 110 KiB (gzip 26) | `APP` to `flockstack` |
| `flockstack-replies-eu` | 110 KiB | `APP` to `flockstack-eu` |

The resolved configuration (`unstable_readConfig`) shows the EU environment inheriting the Durable Object migration `editor-v1` (`new_sqlite_classes: ["CampaignRoom"]`), `no_bundle`, the compatibility flags, `workers_dev: false`, `preview_urls: false` and observability. A dry run does not check that a service binding's target and entrypoint exist; the real deploy does.

## Findings in the configurations

Nothing was edited. Each is for the owner or the next change to decide.

1. **No `account_id` in `workers/collaboration/wrangler.jsonc` or `workers/replies/wrangler.jsonc`.** Every other config pins it. A token that sees more than one account makes the deploy ask or fail. The scripts here export `CLOUDFLARE_ACCOUNT_ID` for secrets; do the same for the deploy commands below, or add the line.
2. **The replies Worker has no `workers_dev: false`, `preview_urls: false` or `observability`.** As written a deploy publishes `flockstack-replies.<subdomain>.workers.dev` (it has no `fetch`, so it only answers an error) and keeps no logs of a Worker whose failures are otherwise invisible: a thrown error becomes a temporary failure at the sender's mail server. Add the three lines as the collaboration Worker has them. `wrangler tail` shows live calls without them.
3. **The collaboration Worker's switch is a `vars` entry set to `"false"`.** Every plain `wrangler deploy` of it puts the flag back off. Enabling it therefore needs `--var COLLABORATION_ENABLED:true` on each deploy (below), or a config edit. A secret of the same name is not a way around it: a binding name is one or the other, and what a deploy does to a secret that shares a var's name was not tried. The app's and the API Worker's flags have no `vars` entry, so a secret persists there.
4. **The bindings that connect the Workers are in no config.** The router and the app need `COLLABORATION_SOCKET`, the app and the API Worker need `COLLABORATION_STORAGE`, and `docs/EDITOR-COLLABORATION.md` says not to add them to a normal deployment (a service binding to a Worker that does not exist fails the deploy). So enabling means editing four configs (twice for the EU) and deploying the app, the API Worker and the router. Do that on a branch and merge it after both regions work, so `main` never names a missing Worker. The snippets are in A.3.
5. **There is no router flag for collaboration** (unlike `API_ENABLED` and `READERS_ENABLED`). The router sends `/api/collaboration/socket` to its `COLLABORATION_SOCKET` binding when it has one, before it looks at the host, and answers 503 when it has none. The whole switch is the binding plus `COLLABORATION_ENABLED` on three Workers. The replies Worker has no router involvement at all: Email Routing calls it and it calls the app through its own binding.
6. **Circular service bindings.** The collaboration Worker calls the API Worker (`AUTHORITY`), and the API Worker calls the collaboration Worker (`COLLABORATION_STORAGE`). That is allowed when the order below is kept: the collaboration Worker first (the API Worker exists), then the API Worker with its new binding.
7. **Keep `COLLABORATION_STORAGE` on the app and the API Worker after switching the feature off.** The hourly cleanup of idle editor snapshots (30 days; they can hold deleted text) and account deletion's purge both need it. Without it cleanup silently does nothing (`cleanupUnavailable`) and deleting an account that used the editor is deferred with an error.
8. **Realtime editing cannot be tried on a `workers.dev` address.** The collaboration Worker accepts only the origin in its `APP_URL` (`https://flockstack.io` or `https://eu.flockstack.io`), so the staged routers cannot reach it. The test is on the real domains, with the feature on for every account of the region while it runs (there is no per-account switch). Do it in the EU first if the US has real users, or at a quiet hour.
9. **`COLLABORATION_ENABLED` has three readers**: the app (`process.env`, shows the button and the editor page), the API Worker (`CollaborationAuthority`, answers every ticket and checkpoint) and the collaboration Worker (`env`, refuses sockets). `scripts/set-api-secrets.sh` does not ask for it; `scripts/set-optional-worker-secrets.sh` (new) does.
10. **README's Stripe webhook list is short** (not a Worker setting): it names nine events and the code handles six more, `customer.subscription.paused` and `.resumed` and the sponsorship invoice events `invoice.finalized`, `.voided`, `.marked_uncollectible` and `.updated`. See release QA, step 2.14.
11. **What Email Routing does with a thrown error** from the replies Worker (it throws for "not configured" and for an app answer other than 2xx, 400 and 404) is not documented in this repository. Step B.5 sends a mail that provokes a clean rejection; do it before trusting the setup, and `wrangler tail` while testing.
12. **The reader catalog has one duplicated row** (`Refresh billing`, in `lib/reader-language-copy.js`, identical both times). Harmless; the import script updates all rows of a key.

## A. Realtime editing

**What it is for.** Two or more people edit one rich-text draft at the same time with live carets, and discuss it in private threads. Off by default. It changes nothing for a draft until someone presses **Edit together and discuss privately**.

**What it needs.**

| Piece | US | EU |
| --- | --- | --- |
| Worker (new) | `flockstack-collaboration` | `flockstack-collaboration-eu` |
| Durable Object | `CampaignRoom`, SQLite, migration tag `editor-v1`, binding `ROOMS`; one object per account and issue | the same, created in the EU jurisdiction (`ROOMS.jurisdiction("eu")`) |
| Authority | `AUTHORITY` to `flockstack-api#CollaborationAuthority` (already exported by the deployed API Worker) | `flockstack-api-eu#CollaborationAuthority` |
| On the collaboration Worker | vars `FLOCKSTACK_REGION`, `APP_URL`, `COLLABORATION_ENABLED` | the same with `eu`, `https://eu.flockstack.io` |
| Added to the router (`env.us`, `env.eu`) | service binding `COLLABORATION_SOCKET` to the collaboration Worker | to the EU one |
| Added to the app (root, `env.eu`) | `COLLABORATION_SOCKET` and `COLLABORATION_STORAGE` (entrypoint `CollaborationStorage`) | the same, EU Worker |
| Added to the API Worker | `COLLABORATION_STORAGE` | the same, EU Worker |
| Secrets | none | none |
| Flag | `COLLABORATION_ENABLED=true` on the API Worker, the app (secrets) and the collaboration Worker (`--var`) | the same |
| Queues, routes, custom domain, D1, R2 | none | none |

Sessions, seats and drafts are checked by the API Worker against D1 on every edit; the collaboration Worker holds no data of its own besides the room state, which is also saved to D1 snapshots.

**Steps, US; then the same with `--env eu` and the `-eu` names.**

1. **Agent.** `npm run test:collaboration` (12 native tests; builds the API and collaboration bundles) and `npx wrangler deploy --dry-run --config workers/collaboration/wrangler.jsonc --outdir ../dry` (as above). Expect: pass.
2. **Owner terminal*.** `npx wrangler deploy --config workers/collaboration/wrangler.jsonc` (EU: `--env eu`). Wrangler warns that several environments exist; the US is the top level. This creates the Worker, its Durable Object class (migration `editor-v1`) and the `AUTHORITY` binding. It receives nothing: it has no route and no `workers.dev` address. Expect: `Deployed flockstack-collaboration`. If it fails on the entrypoint, the API Worker does not export `CollaborationAuthority` (the deployed one was built from `6b846d6` and does).
3. **Agent, on a branch** `release/collaboration-bindings` (not `main`): add the bindings. In `wrangler.jsonc` of the app, to `services` of the root and, with the `-eu` names, of `env.eu`:

   ```jsonc
   { "binding": "COLLABORATION_SOCKET", "service": "flockstack-collaboration" },
   { "binding": "COLLABORATION_STORAGE", "service": "flockstack-collaboration", "entrypoint": "CollaborationStorage" }
   ```

   In `workers/api/wrangler.jsonc`, to `services` of the root and `env.eu`:

   ```jsonc
   { "binding": "COLLABORATION_STORAGE", "service": "flockstack-collaboration", "entrypoint": "CollaborationStorage" }
   ```

   In `workers/router/wrangler.jsonc`, to `services` of `env.us` and `env.eu` only:

   ```jsonc
   { "binding": "COLLABORATION_SOCKET", "service": "flockstack-collaboration" }
   ```

   `npm test` should still pass.
4. **Owner terminal*.** `node scripts/deploy-all.mjs --only us --skip-build --dry-run`, read the plan, then without `--dry-run`. Order: app, API, readers, public, router. Nothing changes for visitors: the router now sends the socket path to the collaboration Worker, which answers 503 while its flag is false, as the router did before. Expect: all five succeed.
5. **Owner terminal.** Check the wiring without any flag: `curl -si https://flockstack.io/api/collaboration/socket | head -1`. Expect: `503` ("Collaborative editing is unavailable"). Then `npx wrangler tail flockstack-collaboration` in another terminal for the next steps.
6. **Owner terminal*.** The flags, the collaboration Worker first, then the API Worker, then the app (the app's is what shows the button):

   ```sh
   npx wrangler deploy --config workers/collaboration/wrangler.jsonc --var COLLABORATION_ENABLED:true
   bash scripts/set-optional-worker-secrets.sh collaboration us
   ```

   The script asks you to type the region, then sets the API Worker's and the app's `COLLABORATION_ENABLED`. Run `bash scripts/set-optional-worker-secrets.sh collaboration us --dry-run` first to see it.
7. **Owner terminal.** `curl -si https://flockstack.io/api/collaboration/socket | head -1`. Expect: `426` ("WebSocket required"): the router, the binding and the flag are all right. `curl -si -H 'upgrade: websocket' -H 'origin: https://other.example' https://flockstack.io/api/collaboration/socket | head -1` Expect: `403`.
8. **Owner browser.** Release QA section 3 (two browsers). Keep `wrangler tail` open.
9. **Agent.** Merge the branch of step 3 into `main` once both regions work (`docs/EDITOR-COLLABORATION.md` step 3 then describes `main`).

**Rollback.**

- Switch it off, in seconds: `bash scripts/set-optional-worker-secrets.sh collaboration us --off*` (deletes the app's flag, then the API Worker's; wrangler asks to confirm each). The button disappears and tickets are refused. Open editors end at the next message.
- Make the Worker refuse too: redeploy it without `--var` (`npx wrangler deploy --config workers/collaboration/wrangler.jsonc`, the flag is `"false"` again), or `npx wrangler rollback --config workers/collaboration/wrangler.jsonc`.
- Leave the bindings and the Worker in place (finding 7). Removing them is a revert of the branch and a redeploy of the app, API Worker and router; do it only after `expireCollaborationSnapshots` has had its 30 days, or after exporting what you need.
- Drafts keep their last saved text. Editor snapshots and threads stay in D1 until the cleanup removes them or the account is deleted.

## B. Inbound replies

**What it is for.** A reader's reply to an issue lands in the newsletter's **Replies** inbox instead of the sender's own mailbox. The owner turns it on per newsletter in **Reader settings**; until then and for every issue already sent, replies go where they always went. Plain text only, no attachments, no automatic answer, 90 days.

**How it works.** The app writes the issue's `Reply-To` as `r-<message id>-<signature>@<REPLIES_DOMAIN>` (the signature is made from `BETTER_AUTH_SECRET`). A reader's reply goes to that domain; Cloudflare Email Routing hands it to the replies Worker, which parses it (size 1 MB at most), signs the JSON with `REPLY_INGEST_SECRET` and a timestamp (five minutes' tolerance) and posts it to the app's `/api/inbound-replies` through its `APP` service binding. The app checks the signature, the address and that the sender is the contact the message was sent to, then stores it.

**What it needs.**

| Piece | US | EU |
| --- | --- | --- |
| Worker (new) | `flockstack-replies` | `flockstack-replies-eu` |
| Binding | `APP` to `flockstack` (no database, no queue, no Durable Object, no route) | `APP` to `flockstack-eu` |
| An incoming subdomain, with Email Routing | for example `replies.flockstack.io` | for example `replies-eu.flockstack.io` |
| Email Routing rule | catch-all on that subdomain: send to the Worker `flockstack-replies` | to `flockstack-replies-eu` |
| `REPLY_INGEST_SECRET` | secret on the app, the API Worker and the replies Worker (one value per region) | its own |
| `REPLIES_DOMAIN` | on the app and the API Worker (the API Worker checks it when `update_reader_settings` turns the inbox on) | its own |
| `REPLY_INGEST_SECRET_PREVIOUS` | on the app only, during a rotation | |

The two regions use different subdomains and different secrets and never share a Worker. Do not choose the apex of a domain that receives mail already: use a subdomain and let Email Routing add its MX records there.

**Steps, US; then EU.**

1. **Agent.** `npx wrangler deploy --dry-run --config workers/replies/wrangler.jsonc --outdir ../dry` and the size budget `npm run perf:budget` (72.8 KB of 100 KB). Optionally fix findings 1 and 2 first.
2. **Owner terminal*.** `npx wrangler deploy --config workers/replies/wrangler.jsonc` (EU: `--env eu`). Expect: it deploys; it has no secret yet and throws "Reply inbox is not configured" if mail reaches it, which nothing sends yet.
3. **Owner terminal*.** `bash scripts/set-optional-worker-secrets.sh replies us` (`--dry-run` first to see the plan). It asks for the subdomain, then for `REPLY_INGEST_SECRET` (hidden, twice; Enter makes a random one that is never shown), and sets the secret on the app, the API Worker and the replies Worker, and the domain last on the app and the API Worker. Values go to `wrangler secret put` on standard input and are not printed. Expect: five `set ...` lines.
4. **Owner browser*.** Cloudflare, the zone of the subdomain's parent: Email, Email Routing. Enable it for the subdomain (the dashboard's subdomain setting adds the MX and SPF records for it only), then Routing rules, catch-all: action **Send to a Worker**, destination `flockstack-replies`. Dashboard labels change; the goal is a catch-all on that subdomain only. Do not change the apex's records.
5. **Owner terminal.** The three checks of release QA section 4 (1 to 3): the app answers `401` to an unsigned POST; a mail to `anything@<REPLIES_DOMAIN>` bounces with "Reply address not available" (the Worker reached the app and the app refused the unknown address; `npx wrangler tail flockstack-replies` shows it); then a real reply to a test issue appears in **Replies**.
6. **Owner browser.** Turn the reply inbox on for the newsletters that want it. Nothing else turns itself on.
7. EU: the same with `--env eu`, its own subdomain and `flockstack-replies-eu`.

**Rotating the secret.** Put the old value on the app as `REPLY_INGEST_SECRET_PREVIOUS`, set the new value everywhere (`bash scripts/set-optional-worker-secrets.sh replies us` makes and sets a new one on all three), then delete the previous one. Reply addresses are signed with the app's rotation-aware key, so addresses already sent keep working (`docs/AUTH-ROTATION.md`).

**Rollback.**

- At once: `bash scripts/set-optional-worker-secrets.sh replies us --off*`. The app stops writing reply addresses (the next issues carry the direct reply-to again, because both names are gone). Issues already sent keep their reply-to, and mail to it reaches the Worker, which has no secret now and throws "Reply inbox is not configured": a temporary failure at the sender's side, not a clean bounce. So also disable the Email Routing rule (next line) if issues with a reply address are still in readers' inboxes.
- Stop mail reaching the Worker: in Email Routing, disable the catch-all rule or the subdomain.
- A bad Worker version: `npx wrangler rollback --config workers/replies/wrangler.jsonc [--env eu]`.
- Replies already stored stay in the inbox until their 90 days end, or the owner archives them; they are in the account export.
