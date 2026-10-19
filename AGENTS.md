<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FlockStack

Read this before working on FlockStack. If `AGENTS.cloud.md` is next to it (FlockStack Cloud's own repository), read that too.

## What it is

FlockStack is a newsletter app: write an issue, send it to your list, publish it on the web. Everything the dashboard does also works from an AI agent, through a REST API and an MCP server.

It's open source under the AGPL-3.0 (`LICENSE`): anyone can run it on their own server with their own Amazon SES or PostShiba account, change it and share it. The README is the self-hosting guide. FlockStack Cloud ([flockstack.io](https://flockstack.io)) runs this same code for people who'd rather not host it.

## How it's organized

Next.js App Router in JavaScript, Tailwind CSS with shadcn/ui, Cloudflare D1 through `lib/docdb` (a Mongoose-compatible document layer: models in `models/` and their queries read like Mongoose), Better Auth for sign-in. It runs on Cloudflare Workers through OpenNext (`wrangler.jsonc`); `PORT-PLAN.md` has the architecture and what is left.

- **Dashboard**: `app/(app)` (overview, campaigns, contacts, newsletters, domains, API keys), `app/(account)` (account, billing), `app/admin`, the sign-in at `app/signin` and the newsletter setup at `app/welcome`.
- **Public pages**: the docs in `app/(site)`, each newsletter's archive in `app/archive`, and what emails link to (`app/unsubscribe`, `app/confirm`, `app/keep`, tracking in `app/o` and `app/c`). `proxy.js` routes newsletters' own hosts to their archive and only checks that a session cookie is there.
- **Actions**: every customer action is one `defineAction` in `lib/actions/<group>.js` (schemas, permission, handler). `runAction` is the only way to run one: from the dashboard's server actions, the REST API (`app/api/v1`) and MCP (`/mcp`, `lib/mcp/server.js`). The docs, the OpenAPI document and the llms files are generated from the same schemas, and `tests/parity.test.mjs` fails when an action is missing from any of them.
- **Accounts**: `scoped(account, filter)` (`lib/account-scope.js`) adds the account to every query, and `lib/docdb/model.js` refuses customer queries without one. `requireAccount()` for pages and server actions, `authenticateRequest()` for the API and MCP (`lib/auth.js`, `lib/api-keys.js`).
- **MCP and OAuth**: API keys, or OAuth access tokens from Better Auth's OAuth provider (`lib/auth.js`, `lib/oauth.js`, `lib/oauth-rules.js`), with the consent page at `app/oauth/consent`.
- **Jobs**: QStash calls `app/api/jobs/*`: sending batches, scheduled sends, first-send checks, the purge of deleted accounts, the steps of an account export (`lib/account-export.js`: each step publishes the next, and the files wait in the private `EXPORTS` bucket for a signed download), the steps of taking a deleted tag or custom field off a large list (`lib/bulk-removal.js`, `remove-from-contacts`) and `run-automations`, which a QStash schedule calls every 5 minutes (`lib/automations.js`). A cron calls `app/api/cron/hourly` with `CRON_SECRET`: PostShiba's team status, the extra emails Polar hasn't been told about (`lib/extra-emails.js`) and dedicated IPs out of line with their add-on (`lib/dedicated-ip.js`). Another calls `app/api/cron/postmaster` every day: Gmail's spam rates from Google Postmaster Tools (`lib/postmaster.js`), connected on `/admin`.
- **Email providers**: `lib/email-provider` switches between `ses.js` and `postshiba.js` (tenants, domains, sends), and their events become one shape (`lib/email-event-rules.js`). FlockStack's own emails (sign-in codes, alerts) go through `lib/platform-email.js`: Resend, or the provider.
- **Webhooks**: outgoing events leave only through `emitWebhookEvent` (`lib/webhooks.js`), and every type is in `lib/webhook-events.js` with its example, which the actions, docs, dashboard and tests read. Each delivery attempt is a QStash job (`app/api/jobs/deliver-webhook`) that signs the body Standard Webhooks style (`lib/webhook-signing.js`) and publishes its own retry; addresses pass `lib/webhook-url.js` at creation and before every attempt. The delivery log keeps the latest deliveries per endpoint only. `integrations/` holds the Zapier and Make apps, separate packages that call the REST API and aren't part of the build.
- **Regions**: FlockStack Cloud is this code deployed as two Workers, `flockstack` (US) and `flockstack-eu` (`env.eu` in `wrangler.jsonc`), each with its own database and buckets and `FLOCKSTACK_REGION` set. `lib/region.js` has the region, the session cookie prefix, the API key prefix (`mc_`, `mc_eu_`), each region's address and the sign-up picker's choice; an account lives in exactly one region and nothing looks across. A webhook can deliver to both Workers, so an event for an account this region doesn't have is acknowledged and logged at info level, never alerted (`noteOtherRegion`). One build serves both, so anything that shows `APP_URL` is read per request (`dynamic = "force-dynamic"`), never at build. `node scripts/deploy-all.mjs` deploys both; the README's Regions section has the rest.
- **Domains on Cloudflare**: `lib/cloudflare-api.js` is the only module that calls Cloudflare's API (`CLOUDFLARE_API_TOKEN`; tests get `tests/stubs/cloudflare-api.mjs`). On FlockStack Cloud with `CLOUDFLARE_SAAS_ZONE_ID`, a customer's archive subdomain is a Cloudflare for SaaS custom hostname with a Worker route to its region's Worker (`lib/custom-hostnames.js`), ready only once Cloudflare reports it and its certificate active; `ARCHIVE_TRUSTED_HOSTS` never reach the API. Shared addresses' DNS records go to `CLOUDFLARE_SHARED_ZONE_ID` or, without it, the DNS helper (`lib/shared-dns.js`). README, Domains on Cloudflare, has the owner's setup.
- **Alerts**: `sendAlert` (`lib/alerts.js`) emails an account's owner, or `ADMIN_EMAILS` for the admins'. `lib/alert-rules.js` says which admin alerts need someone; those go to Telegram too (`lib/telegram.js`) when it's set up. A new admin alert gets its kind there, or `tests/alerts.test.mjs` fails. Before an automatic block, `lib/account-watch.js` warns: past the watch level (`WATCH` in `lib/config.js`) the owner is emailed once per issue per period, the dashboard shows `BannerWatch` and the admins get a record; a spam trap still blocks at once.
- **Selling**: products, orders and paid subscriptions (`lib/payments`, `lib/actions/products.js`, `lib/actions/payments.js`), apart from FlockStack's own plan billing. Readers pay the creator's own Stripe account (Stripe Connect on FlockStack Cloud, the owner's key when self-hosted) and FlockStack takes no cut: never set an application fee. The webhook is `app/api/webhooks/payments`; product files stay in the private `FILES` bucket and leave it only through a signed link (`app/api/shop/download`).
- **Storage**: models in `models/` (D1 in production, SQLite for tests and local scripts), images in the R2 bucket bound as `IMAGES`, or S3 behind CloudFront, or Vercel Blob (`lib/image-storage.js`), rate limits in Upstash Redis or memory (`lib/rate-limit.js`).
- **Comments**: subscribers comment on the web issues with no account: a signed link (`lib/reader-links.js`, four kinds, each signed with a key of its own) starts a session for one newsletter (`lib/reader-session.js`), and every function checks the contact is still an active subscriber. A comment's text is parsed to parts and printed as text, never HTML (`lib/comment-body.js`). Readers act through `lib/comments.js`, the owner through `lib/comment-moderation.js` and the `Comments` actions; hiding and removing always carry a reason the author sees. Emails (`lib/comment-notify.js`) are one digest an hour at most to the owner and one reply email to an author, never one per comment. A reader's email never appears in anything public.
- **Growth**: each newsletter's RSS feed (`lib/archive-feed.js`), the account export (any account may run it, even blocked or without a plan: `export_account_data` sets `whileBlocked` and `requiresPlan: false`, and that stays so) and the referral program (`lib/referrals.js`; reward emails are `Message` kind `referral`, sent like welcome emails). Newsletters recommend each other for free (`lib/recommendations.js`, rules in `lib/recommendation-rules.js`): a reader's email reaches another newsletter only through their own tick on the "You might also like" step, as a normal signup with that newsletter's confirmation email, and the dashboard is at `/recommending` because `/recommendations` is the public directory. Recommendations stay inside a region.

## FlockStack Cloud and self-hosting

`isCloud()` in `lib/config.js` is `FLOCKSTACK_CLOUD === "true"`, what flockstack.io runs with: open sign-up, plans and Stripe billing. Anything else is a self-hosted server: only the allowlist (`ADMIN_EMAILS`, `ALLOWED_EMAILS`) signs in, there's no billing and no limits. Both run from the same files, so a change has to work in both modes.

FlockStack Cloud's marketing site, analytics and support chat aren't part of the open source. Shared code reaches them only through the site extensions, `lib/site-extensions.js` and `components/SiteExtensions.jsx`, whose defaults add nothing: never import cloud-only code anywhere else. Shared client code reports a step worth counting with `reportGoal` (`lib/goals.js`, a window event, like `lib/sign-out.js`), and the server with `siteExtensions.sendGoalOnNextPage`; the analytics (PostHog, `lib/marketing`, `components/marketing`) carries only FlockStack's own pages, never a newsletter's or a reader's, and `tests/analytics-routes.test.mjs` lists where.

## Rules

- The code is public: never commit secrets, keys, tokens or personal data (emails, phone numbers, addresses, customers' data), in code, tests, fixtures or commit messages. Tests use `example.com` and made-up values.
- Write "FlockStack" in display text: copy, titles, emails, docs, comments. Lowercase in identifiers and machine names: `flockstack.io`, `FLOCKSTACK_CLOUD`, `LogoFlockstack`, package and file names.
- Copy is plain and short, in sentence case: only the first word of a title or a button is capitalized.
- Legal pages (`/terms`, `/privacy`, `/sub-processors`): what the company decides lives in `lib/legal.js`, and a value starting with `TODO:` is a placeholder (`node scripts/check-legal.mjs` lists them; while any is left the pages answer 404 and nothing links to them, through `getPublishedLegalPages()`). A change to what the product stores, sends, shares or sets as a cookie changes the pages (`lib/subprocessors.js`, `lib/docs/regions.js`) in the same commit, and says only what the code does.
- Regions: say "data stored in the EU" or "EU-deployable", never "EU-resident", until every subprocessor in `lib/docs/regions.js` is verified.

## Code style

- JavaScript, no TypeScript. Tabs. Don't run Prettier: it reformats whole files.
- Components in `components/`, in PascalCase and named by their kind first (`ButtonCopy.jsx`, `CardUsage.jsx`); other files in kebab-case. Server components by default, `"use client"` only where the browser is needed.
- Comments only for what the code can't show: a constraint, a reason, an outside rule. Not what the next line does.
- Read the code around a change and write like it.

## Tests

```bash
npm test       # node --test, each integration test file gets its own in-memory SQLite (lib/docdb); scripts/test-all.mjs runs the files in parallel
npm run lint
npm run build
```

Tests import server actions and route handlers as they are; `tests/setup` stubs Next.js request APIs and every outside service, so nothing reaches the network. A change to behavior comes with its test, and the full suite and lint pass before it's pushed.
