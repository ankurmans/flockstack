# Optional Workers: realtime editing and inbound replies

Two services are built and deployed nowhere. `node scripts/deploy-all.mjs` deploys neither unless a region's setting says its Worker exists (next section), no config of a Worker that runs today names them, and their switches are off. This page is how to provision each, region by region, US first and EU a day later. Nothing here has been run against production; the commands that change production are marked *.

## The setting that makes a deploy include them

A deploy must never name a Worker that does not exist (a service binding to a missing Worker fails the deploy of the Worker that holds it), so the repository's configurations of the app, API Worker, readers, public pages and router carry no optional binding at all, and a test fails if one appears. Instead `scripts/deploy-all.mjs` reads one setting per deployment and, for a region whose Worker exists, adds the bindings to a copy of those configurations for that deploy only (`wrangler.optional.jsonc` beside each original, removed afterwards, git-ignored) and deploys the optional Worker itself.

The setting is JSON, in the environment variable `FLOCKSTACK_OPTIONAL_WORKERS` or, when that is unset, in the file `optional-workers.json` at the repository root (git-ignored, because it describes one deployment; an empty variable means none, whatever the file says):

```json
{
	"us": { "collaboration": "enabled", "replies": true },
	"eu": { "collaboration": { "state": "provisioned", "testOrigins": ["https://flockstack-router-eu.example.workers.dev"] } }
}
```

| Key | Values | Effect on `node scripts/deploy-all.mjs` |
| --- | --- | --- |
| `collaboration` | `"off"` (the default), `"provisioned"`, `"enabled"` | `provisioned`: the region's collaboration Worker is deployed first with its flag off, and the app (`COLLABORATION_SOCKET`, `COLLABORATION_STORAGE`), the API Worker (`COLLABORATION_STORAGE`) and the router (`COLLABORATION_SOCKET`, both its workers.dev and its domain variants) get the bindings. `enabled`: the same, and every deploy of the collaboration Worker passes `--var COLLABORATION_ENABLED:true`, so a later deploy never turns it back off. |
| `collaboration.testOrigins` | up to five exact origins (`https://…`, or `http://localhost:…`), only with `provisioned` or `enabled` | The collaboration Worker also accepts sockets from those origins (`--var COLLABORATION_ALLOWED_ORIGINS`), to try realtime editing on a `workers.dev` router before a domain moves. No wildcards, no paths; the dashboard's own origin always works. Remove them when the test is over. |
| `replies` | `true` or `false` | The replies Worker is deployed last in its region. It needs no binding anywhere else. |

Set `provisioned` or `true` only after the step that creates the Worker has been done for that region (A.2, B.2 below): the setting is the one place that says it exists. A value it does not understand stops the run before anything is built, migrated or deployed. `node scripts/deploy-all.mjs --dry-run` prints an "Optional Workers" line per region, each added binding, and the commands.

**`COLLABORATION_ENABLED` on the app and the API Worker is a secret** (`scripts/set-optional-worker-secrets.sh`), and Wrangler never removes a secret on deploy (`keepSecrets` in its deploy code), so a plain deploy of the app, API Worker or router leaves it as it is. The copies `deploy-all` makes deliberately never contain that name as a variable: a variable and a secret of one name would clash. Only the collaboration Worker's flag is a variable, which is why the setting's `enabled` exists. For what to look at afterwards see [release QA](RELEASE-QA.md), sections 3 and 4. For the design see [editor collaboration](EDITOR-COLLABORATION.md) and [reply rules](REPLY-RULES.md) (the inbox itself is in [handover builds](HANDOVER-BUILDS.md)).

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

The first dry run found these. Items 1 to 5, 8 and 10 are now handled in the repository; the rest are things to know.

1. **Fixed: no `account_id` in `workers/collaboration/wrangler.jsonc` or `workers/replies/wrangler.jsonc`.** Both now pin the account like every other config, in the top level and in `env.eu`.
2. **Fixed: the replies Worker had no `workers_dev: false`, `preview_urls: false` or `observability`.** It has them now, in both environments, so a deploy publishes no `workers.dev` address and its failures are logged (a thrown error becomes a temporary failure at the sender's mail server, so the logs matter). `wrangler tail` still shows live calls.
3. **Fixed: the collaboration Worker's switch was a `vars` entry set to `"false"`, which every plain deploy of it put back.** `"enabled"` in the setting above makes `deploy-all` pass `--var COLLABORATION_ENABLED:true` on every deploy of that Worker, so it stays on. On the app and the API Worker the flag is a secret and Wrangler keeps secrets on every deploy (it was checked in its deploy code), so a plain deploy of the app, API Worker or router does not reset it; the generated configurations never write the name as a variable because a variable and a secret of one name would clash. If the flag was ever set as a plain variable in the dashboard, a deploy removes it: set it with the script, as a secret.
4. **Fixed: the bindings that connect the Workers are in no config, by design.** The router and the app need `COLLABORATION_SOCKET`, the app and the API Worker need `COLLABORATION_STORAGE`, and a service binding to a Worker that does not exist fails the deploy. `deploy-all` adds them to a copy of the configuration only for a region whose setting says the collaboration Worker exists, so `main` never names a missing Worker and no branch is needed.
5. **There is no router flag for collaboration** (unlike `API_ENABLED` and `READERS_ENABLED`). The router sends `/api/collaboration/socket` to its `COLLABORATION_SOCKET` binding when it has one, before it looks at the host, and answers 503 when it has none. The whole switch is the binding plus `COLLABORATION_ENABLED` on three Workers. The replies Worker has no router involvement at all: Email Routing calls it and it calls the app through its own binding.
6. **Circular service bindings.** The collaboration Worker calls the API Worker (`AUTHORITY`), and the API Worker calls the collaboration Worker (`COLLABORATION_STORAGE`). That is allowed when the order below is kept: the collaboration Worker first (the API Worker exists), then the API Worker with its new binding.
7. **Keep `COLLABORATION_STORAGE` on the app and the API Worker after switching the feature off.** The hourly cleanup of idle editor snapshots (30 days; they can hold deleted text) and account deletion's purge both need it. Without it cleanup silently does nothing (`cleanupUnavailable`) and deleting an account that used the editor is deferred with an error.
8. **Fixed: realtime editing could not be tried on a `workers.dev` address.** The collaboration Worker accepted only the origin in its `APP_URL`. It now also accepts the exact origins listed in `testOrigins` of the setting (`COLLABORATION_ALLOWED_ORIGINS`), so a staged router on `workers.dev` can be tried before a domain moves. Two things stay true. Sessions and links belong to the real domain (the EU app has no `workers.dev` address for that reason), so signing in on a `workers.dev` address may not work at all; this was not tried, and the socket's origin check is the only thing `testOrigins` changes. And the feature is still on for every account of the region while the flag is on (there is no per-account switch). Do it in the EU first if the US has real users, or at a quiet hour, and remove `testOrigins` afterwards.
9. **`COLLABORATION_ENABLED` has three readers**: the app (`process.env`, shows the button and the editor page), the API Worker (`CollaborationAuthority`, answers every ticket and checkpoint) and the collaboration Worker (`env`, refuses sockets). `scripts/set-api-secrets.sh` does not ask for it; `scripts/set-optional-worker-secrets.sh` does.
10. **Fixed: README's Stripe webhook list was short** (not a Worker setting): it named nine events and the code handles six more. The README, the selling guide and the release QA page now come from one list, `lib/payments/event-types.js`, which a test holds to the handlers. The production endpoint still has to list them all (release QA, step 2.14).
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
| Added by `deploy-all` to the router (all its variants of the region) | service binding `COLLABORATION_SOCKET` to the collaboration Worker | to the EU one |
| Added by `deploy-all` to the app (root, `env.eu`) | `COLLABORATION_SOCKET` and `COLLABORATION_STORAGE` (entrypoint `CollaborationStorage`) | the same, EU Worker |
| Added by `deploy-all` to the API Worker | `COLLABORATION_STORAGE` | the same, EU Worker |
| Secrets | none | none |
| Flag | `COLLABORATION_ENABLED=true` on the API Worker, the app (secrets) and the collaboration Worker (`--var`) | the same |
| Queues, routes, custom domain, D1, R2 | none | none |

Sessions, seats and drafts are checked by the API Worker against D1 on every edit; the collaboration Worker holds no data of its own besides the room state, which is also saved to D1 snapshots.

**Steps, US; then the same with `--env eu` and the `-eu` names.**

1. **Agent.** `npm run test:collaboration` (12 native tests; builds the API and collaboration bundles) and `npx wrangler deploy --dry-run --config workers/collaboration/wrangler.jsonc --outdir ../dry` (as above). Expect: pass.
2. **Owner terminal*.** `npx wrangler deploy --config workers/collaboration/wrangler.jsonc` (EU: `--env eu`). Wrangler warns that several environments exist; the US is the top level. This creates the Worker, its Durable Object class (migration `editor-v1`) and the `AUTHORITY` binding. It receives nothing: it has no route and no `workers.dev` address. Expect: `Deployed flockstack-collaboration`. If it fails on the entrypoint, the API Worker does not export `CollaborationAuthority` (the deployed one was built from `6b846d6` and does).
3. **Owner terminal.** Say the Worker exists, in the setting of the section above: `export FLOCKSTACK_OPTIONAL_WORKERS='{"us":{"collaboration":"provisioned"}}'` (or the file `optional-workers.json`; EU: `"eu"`, and keep the US entry when both exist). Nothing in the repository changes, and `node scripts/deploy-all.mjs --only us --skip-build --dry-run` now lists the Worker and the bindings it would add to the app, the API Worker and the router.
4. **Owner terminal*.** `node scripts/deploy-all.mjs --only us --skip-build` without `--dry-run` (read the plan first). Order: the collaboration Worker, app, API, readers, public, router. Nothing changes for visitors: the router now sends the socket path to the collaboration Worker, which answers 503 while its flag is false, as the router did before. Expect: all six succeed.
5. **Owner terminal.** Check the wiring without any flag: `curl -si https://flockstack.io/api/collaboration/socket | head -1`. Expect: `503` ("Collaborative editing is unavailable"). Then `npx wrangler tail flockstack-collaboration` in another terminal for the next steps.
6. **Owner terminal*.** The flags: the secrets on the API Worker, then the app (the app's is what shows the button), and the setting's `enabled` so that every later deploy of the collaboration Worker keeps its own flag on:

   ```sh
   bash scripts/set-optional-worker-secrets.sh collaboration us
   export FLOCKSTACK_OPTIONAL_WORKERS='{"us":{"collaboration":"enabled"}}'
   npx wrangler deploy --config workers/collaboration/wrangler.jsonc --var COLLABORATION_ENABLED:true
   ```

   The script asks you to type the region, then sets the API Worker's and the app's `COLLABORATION_ENABLED`. Run `bash scripts/set-optional-worker-secrets.sh collaboration us --dry-run` first to see it. The last command is what `node scripts/deploy-all.mjs` runs for the Worker from then on; run it by hand now so the flag is on without a full deploy.
7. **Owner terminal.** `curl -si https://flockstack.io/api/collaboration/socket | head -1`. Expect: `426` ("WebSocket required"): the router, the binding and the flag are all right. `curl -si -H 'upgrade: websocket' -H 'origin: https://other.example' https://flockstack.io/api/collaboration/socket | head -1` Expect: `403`.
8. **Owner browser.** Release QA section 3 (two browsers). Keep `wrangler tail` open. To try it on a staged router's `workers.dev` address first, add that exact origin to `testOrigins` (see the setting above), redeploy the collaboration Worker, and remove it afterwards.
9. **Owner terminal.** Keep the setting (the variable in your shell profile or the file) for as long as the Worker is used: a `node scripts/deploy-all.mjs` run without it deploys the app, API Worker and router without the bindings, which turns the feature off for visitors and stops the editor housekeeping (finding 7).

**Rollback.**

- Switch it off, in seconds: `bash scripts/set-optional-worker-secrets.sh collaboration us --off*` (deletes the app's flag, then the API Worker's; wrangler asks to confirm each). The button disappears and tickets are refused. Open editors end at the next message.
- Make the Worker refuse too: set the region back to `"provisioned"` in the setting and redeploy it without `--var` (`npx wrangler deploy --config workers/collaboration/wrangler.jsonc`, the flag is `"false"` again), or `npx wrangler rollback --config workers/collaboration/wrangler.jsonc`. Leaving `"enabled"` in the setting would turn it back on at the next `deploy-all`.
- Leave the bindings and the Worker in place (finding 7). Removing them is setting the region back to `"off"` (or deleting its entry) and a redeploy of the app, API Worker and router with `deploy-all`; do it only after `expireCollaborationSnapshots` has had its 30 days, or after exporting what you need.
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

1. **Agent.** `npx wrangler deploy --dry-run --config workers/replies/wrangler.jsonc --outdir ../dry` and the size budget `npm run perf:budget` (72.8 KB of 100 KB).
2. **Owner terminal*.** `npx wrangler deploy --config workers/replies/wrangler.jsonc` (EU: `--env eu`). Expect: it deploys; it has no secret yet and throws "Reply inbox is not configured" if mail reaches it, which nothing sends yet. Then add `"replies": true` for the region to the setting (section above) so that `node scripts/deploy-all.mjs` keeps its code in step with the app from now on; it needs no binding anywhere else.
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
