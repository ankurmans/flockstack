> FlockStack is a Cloudflare fork of [MailCheap](https://github.com/marclou/mailcheap) by Marc Lou (AGPL-3.0). It runs on Workers, D1 and R2: [PORT-PLAN.md](PORT-PLAN.md) has the architecture and what's left.

<p align="center">
  <a href="https://flockstack.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
      <img src="docs/logo.svg" alt="FlockStack" width="64" height="64">
    </picture>
  </a>
</p>

<h1 align="center">FlockStack</h1>

<p align="center">
  Newsletters where you pay for the emails you send, not for dormant subscribers.<br>
  A fraction of the price of beehiiv and the like.
</p>

<p align="center">
  <a href="https://flockstack.io">Website</a> ·
  <a href="https://flockstack.io/docs">Docs</a> ·
  <a href="https://flockstack.io/signin">Sign up for FlockStack Cloud</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/ankurmans/flockstack?color=blue"></a>
  <a href="#self-hosting"><img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="https://flockstack.io/docs/mcp"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-0a0a0a"></a>
</p>

![FlockStack's overview: emails sent, delivery, open, click, bounce and complaint rates, and subscribers over the last 30 days](docs/screenshots/overview.webp)

FlockStack is a newsletter app: write an issue, send it to your list, publish it on the web, from the dashboard or from your AI agent. This repository is the whole app. Self-host it with your own Amazon SES or PostShiba account, or use [FlockStack Cloud](https://flockstack.io), which runs this same code.

## Features

- **AI agents and the dashboard.** Everything the dashboard does also works from an AI agent through the MCP server, and from code through the REST API, with the same checks and limits. ChatGPT, Claude and Grok Bot connect with OAuth; Claude Code, Codex and Cursor with an API key. MCP marks sending as an action that can't be undone, so agents ask you first.
- **Write, review, send.** Write in an editor with slash commands, images and boxes, or send Markdown or a complete HTML email through the API and MCP. Review shows what to fix before sending: subject, preview text, unsubscribe link, Gmail's 100 KB clip, postal address, sender. Then send it, schedule it, or start with your most engaged readers and send to more later. Send by email and web, email only or web only, under the issue's own sender name, with test emails to up to 10 people.
- **Subject line tests and resends.** Try up to 4 subject lines on a slice of the audience; after the wait the winner, by unique clicks or opens, goes to everyone else by itself. Once an issue is out, send it again with a new subject to the readers who didn't open it, or didn't click, a day later by default.
- **AI writing tools** (Cloudflare Workers AI): select text in the editor and rewrite, shorten, expand, fix or translate it, or change its tone; get five subject lines and three preview texts from the draft, and send subject lines to the subject line test; draft LinkedIn and X posts for an issue, to edit and post yourself. You see a suggestion first and nothing changes until you accept it. Each plan has a daily allowance, and a server without Workers AI hides the buttons ([AI writing tools](#ai-writing-tools)).
- **Editor and dashboard tools.** Version history for drafts (the last 30 states, restorable), a live word count and read time, find and replace (Cmd/Ctrl+F), a media library with folders and a search by name, free Unsplash photos where the server has a key ([Stock photos](#stock-photos)), a calendar of scheduled and sent issues, a Cmd/Ctrl+K command palette, bulk actions on campaigns (delete drafts, list, unlist, move), a link-in-bio page at `/links` on each newsletter's website, tag colors, and a dashboard that installs as an app from the browser (a manifest and icons only: no service worker, nothing works offline). All of it is in the REST API and MCP too, except the palette and the install, which are pages.
- **Imports from beehiiv, Substack and Mailchimp.** Their CSV exports import as they are, with each reader's status and signup date, and so do Kit's, MailerLite's, Buttondown's, Ghost's and EmailOctopus's.
- **Your archive comes too.** Upload a Substack, beehiiv, WordPress or Ghost export: every published post becomes an issue on your website on its original date, with its pictures copied and no email sent, and each old address redirects to its new page.
- **Tags, custom fields and merge tags.** Label contacts with free-form tags and give a newsletter custom fields (text, number, date, date and time, true or false, lists) for a first name, a plan, a renewal date. Set them from the dashboard, imports (a tags column and columns named like the fields), the signup form and API, and REST and MCP. Write `{{first_name|there}}` in a subject or body and each reader's email has their own value.
- **Blocks, polls, surveys and a preference center.** The editor adds a call-to-action button in the newsletter's accent color, embeds (YouTube, X, Instagram, TikTok, Bluesky, Spotify, Apple Podcasts), a paywall break, two columns, tables, file attachments and footnotes, each built for email tables and the website. A poll's answers are one-click signed links that record one vote per subscriber, can set a field or a tag, and show live results; a survey saves answers to custom fields, runs after signup or on the unsubscribe page and exports as CSV; the preference center lets readers change the fields you open to them. Segments filter on a poll's answers.
- **Segments.** Save an audience as rules: status, tags, free or paid, country, referral count, custom fields, signup dates, source, whether they opened or clicked lately, never opened, dormant, who opened or clicked a given issue or one of its links, a poll's answer, imported, with "is any of" and "is none of" lists, joined with and/or groups. Live counts, a builder in the dashboard, a segment saved as a list that keeps the contacts it matched that day, and campaigns that send to any of up to 5 segments, leaving out up to 5 others, through the same suppression, warm-up and list cleanup as any send. A website signup keeps the visitor's country from Cloudflare's `cf-ipcountry` (two letters, never the address); a signup form of your own passes `country` to `add_contact`.
- **Automations.** A welcome series when someone subscribes, a thank-you when a reader upgrades or buys, a nudge when they stop opening, a follow-up when they click a link: triggers on subscribing, tags, segments, dates, custom fields, upgrades, products, referrals, a stretch without opens, a link click, or contacts added by hand or by your code. Steps send emails, wait (a length of time, a date and time, or a weekday), change tags and fields, send an `automation.step` webhook, branch on a segment condition, split contacts at random into 2 to 5 paths, move a contact to another automation or end. They are a tree: a contact keeps its place by step ID when the steps are edited. The dashboard edits the tree and starts from templates (welcome series, re-engagement, paid onboarding, product buyer thank-you, referral thanks). Every email goes through the sending path of a campaign (unsubscribe links, suppression, the plan's emails, the send rate), contacts who unsubscribe or bounce leave, and a report shows who is where and how many each step and path ran for.
- **A website for each newsletter**, on a free subdomain on FlockStack Cloud (`<slug>.flockstack.io`), or on your server: every issue gets a page search engines can find, with a signup form, an author page, share images and a sitemap.
- **Sending from your own domain**, with the DKIM, return path and DMARC records to add and a check for each. On FlockStack Cloud, a newsletter without a domain sends from its own shared address, `hello@<slug>.flockstack.io`.
- **Deliverability protections**, built in:
  - warm-up: contacts the account never emailed go out as a 5% slice first, and the rest 3 hours later if the slice's bounces and complaints stay low. On FlockStack Cloud, an account's sends also speed up as it proves clean volume;
  - list cleanup, on by default: readers who ignored several issues get one "do you still want this?" email, then stop getting issues;
  - contact cleaning: imports leave out invalid, misspelled (gmial.com), spam trap, role, throwaway and duplicate addresses, domains that can't receive email, and anyone who unsubscribed, bounced or complained before;
  - one never-email list for the whole server: an address the email provider says doesn't exist (for 180 days) or that turned out to be a spam trap (for good) is left out of every account's imports, signups and sends, and only a keyed hash of it is kept;
  - spam and bounce limits: a send pauses past 2% hard bounces or 0.08% complaints, and the account is blocked past 5% or 0.3%, or on a spam trap hit;
  - Gmail's spam rates, which Gmail never reports one complaint at a time: every email carries a `Feedback-ID` for Gmail's feedback loop (its campaign or newsletter, its account, its kind), and once an admin connects [Google Postmaster Tools](https://postmaster.google.com), FlockStack reads it every day. An account Gmail flags at 0.08% has its sends paused, at 0.3% it's blocked, and the admins hear when the whole domain reaches 0.1%;
  - one-click unsubscribe (RFC 8058) and a signed unsubscribe link in every email, and confirmed opt-in, on by default.
- **RSS feed** for each newsletter's website, with the full text of the free issues: `/feed.xml` on its own host, linked from every page of the website so feed apps find it.
- **Leave with everything, free, any time.** One click on the account page, or `export_account_data` through the API and MCP, makes ZIP files with every newsletter's contacts as CSV, every issue as Markdown and HTML with frontmatter, your pictures, the suppression list and a manifest, and emails the links to the owner. It works for blocked and paused accounts and accounts without a plan, and it's never a paid feature.
- **Referral program**: every subscriber gets a link of their own; a signup that confirms counts for them, rewards unlock at numbers you set (a link or a message, on the subscriber's referral page and in an email), `{{referral_link}}` and `{{referral_count}}` work in issues, and self-referrals, repeats of one inbox or network and floods don't count.
- **Newsletter recommendations**, free, with no paid placement and no cut of anyone's revenue: a newsletter recommends up to 10 others by slug with a pitch in its own words. After a reader subscribes (or confirms), a "You might also like" step offers them with nothing ticked, and each one they tick is a normal signup to that newsletter with its own confirmation email; a reader's email never reaches a newsletter they didn't tick. The website shows a "Recommended newsletters" section, `{{recommendations}}` prints the block in issues, and each recommendation counts shown, signed-up and confirmed readers. A newsletter can turn incoming recommendations off or decline one with a reason its recommender reads, and can list itself in a directory at `/recommendations`. They work between newsletters of the same region ([docs](https://flockstack.io/docs/recommendations)).
- **Comments from your subscribers**, on each issue's web page, with no accounts or passwords: a reader proves they subscribe with a signed link in your emails (`{{comment_link}}`, and a "Discuss this issue" link in the footer) or a one-time link sent to their address, and other readers never see their email. Off by default; for everyone subscribed or paid subscribers only; one level of replies; you choose whether comments with links, or all comments, wait for your review. Whatever you hide, remove or hold, its author reads your reason. Reports, blocking a commenter (they stay subscribed), one digest email an hour at most, and comments in your export ([Comments](#comments)).
- **Audio versions of issues.** Any issue, a draft or a sent one, can be read aloud in a voice you pick from a list the server's owner curates: a player on the issue's page (play, 15 seconds back and forward, 1x to 2x, remembers where you stopped in the browser and tells nobody), a "Listen to this issue (12 min)" link at the top of its email, and a podcast feed at `/podcast.xml` for Apple Podcasts and Spotify. Text to speech is the server owner's own ElevenLabs account, counted by the character, with a monthly allowance per plan and no overage ([Audio versions](#audio-versions)).
- **Sell to your readers, with no cut for FlockStack.** Digital products (a file readers buy once, kept in a private bucket and delivered by a signed, expiring download link) and paid subscriptions (up to 3 tiers with monthly, quarterly, yearly, lifetime and pay what you want prices, an optional free trial). Readers pay through Stripe Checkout straight to your own Stripe account, and only Stripe's processing fee comes off: FlockStack sets no application fee. Each newsletter gets a shop and product pages on its website. A campaign can go to everyone, free readers, paid readers or one paid tier and the tiers above it; a paid issue is a teaser on the web and whole in the email, and paid readers manage their billing from a link in every email. Refunds and chargebacks stop the download link by themselves ([Selling](#selling-products-and-paid-subscriptions)).
- **Several newsletters**: up to 3 per account, each with its own contacts, campaigns and website.
- **Where subscribers come from.** Each signup keeps its UTM parameters, the website that linked to the form and a channel (direct, search, social, email, paid, another website, a recommendation, your referral program). A browser holds them in its own local storage for 30 days; there are no cookies and no third-party scripts. A setting adds `utm_source` (the newsletter), `utm_medium=email` and `utm_campaign` (the issue's slug) to the links in issues that lead to other sites.
- **Signup forms for other sites.** Build a form in the dashboard (the custom fields you choose, your button's words, colors from your accent color, a message or a page to go to) and put it on any site with one line of code that frames it and sizes the frame, or with a plain HTML form that posts to it. It runs the website form's checks (honeypot, 5 signups per visitor in 10 minutes, confirmed opt-in, suppression) and counts its views (on the server, per day, no script or cookie of ours on the site that shows it), signups and conversion. Its page alone may be framed by other sites (`next.config.mjs`).
- **Reports and website analytics.** The Reports page shows growth by day, week or month for up to two years, split by source, channel, UTM campaign or form with how many are still subscribed; every number is one `GROUP BY` (`Model.groupCount`, `lib/docdb/model.js`), never a read of the list. Your newest issues compare side by side, and every report exports as CSV (`export_report`). The website counts its own visits in one row of counts per newsletter and day (`lib/web-analytics.js`): page views, distinct visitors per day from a sketch fed by a daily-rotating, never-stored hash of the network address and browser, referring hosts, countries from `cf-ipcountry` and the issues read, with no cookie, no storage and no third-party script, and nothing counted for Do Not Track or Global Privacy Control. Newsletter sites keep no third-party tracking pixels.
- **Pop-up settings and gated issues.** The website's pop-up opens after some seconds, part-way down the page or on exit intent (desktop), on the pages you pick, and a closed one stays away for days you set, remembered by a flag in the reader's own browser storage (no cookie). The gate shows older issues, in the page and the RSS feed, as a plain-text beginning and the signup form; the reader-session unlock a paid reader's browser uses (`lib/reader-access.js`) gives the rest to any signed-in subscriber, and a confirmation link or an emailed one-time link starts that session. The dialog traps focus, closes on Escape and respects reduced motion.
- **Magic Links.** One address for another newsletter's readers or an automation: their platform fills in the reader's email and opening it subscribes them in one click. It is signed for the newsletter and a key id (`lib/magic-links.js`), not for an address, so confirmed opt-in still sends the confirmation email, an address gets 3 tries a day and a network 10 in 10 minutes, the page subscribes only when a browser runs it, a contact who unsubscribed stays unsubscribed, and the owner can retire the link.
- **Signups and stats**: signup forms and a signup API, welcome emails, a reminder to signups that haven't confirmed and a page of your own after confirming, open and click tracking that leaves link scanners out, clicks per link with a click map and who clicked each link, subscribers over time, and reports by inbox provider (Gmail, Outlook, Yahoo, iCloud...).

| Write, review, send | The newsletter's website |
| --- | --- |
| ![The campaign editor's Write step: the subject, preview text and body of a draft, with the Write, Review and Send steps at the top](docs/screenshots/editor.webp) | ![A newsletter's website: its signup form, a featured issue and the latest issues](docs/screenshots/website.webp) |

All names and addresses in the screenshots are made up.

## FlockStack Cloud or self-hosted

| | [FlockStack Cloud](https://flockstack.io) | Self-hosted |
| --- | --- | --- |
| Price | Free for 2,500 subscribers and 10,000 emails a month; paid plans from $9 a month for 25,000 emails, extra emails $0.15 per 1,000 | Free, plus what your provider charges per email: $0.10 to $0.16 per 1,000 on Amazon SES |
| Sending | Set up for you, from `hello@<slug>.flockstack.io` or your domain | Your Amazon SES or PostShiba account, from your domain |
| Website | `<slug>.flockstack.io` | `/archive/<slug>` on your server's domain |
| Who signs in | Anyone who signs up | The emails you allow |
| Limits | Emails a month and active subscribers, by plan | None |
| Setup | A few minutes | About an hour, most of it waiting for DNS and production access (SES) |
| Support | A chat in the dashboard | None: issues are off |

FlockStack Cloud is this repository with `FLOCKSTACK_CLOUD=true`, which adds open sign-up, plans and billing (Polar or Stripe). Only active subscribers count toward a plan, not the ones list cleanup marked dormant. Its marketing website (the home page, pricing, comparison, blog and release notes) is a separate program in a private repository, a Worker of its own that this app's Worker reaches through the `WEBSITE` service binding (`worker-entry.mjs` hands it a short list of paths, `lib/website-routing.js`; the app serves `/llms-docs.txt`, the docs part of the website's merged `/llms.txt`). Without the binding, those paths fall through to the app, and a self-hosted server never has it. The analytics, the help chat and the legal pages (`/terms`, `/privacy` and `/sub-processors`, which a self-hosted server doesn't serve, see [Legal pages](#legal-pages)) are in this repository. Every change to the app ships to both.

With your own sending account, you pay your provider for the emails you send: 10,000 readers and 4 issues a month is 40,000 emails, about $4 to $6 on Amazon SES.

## Regions

FlockStack Cloud is this same code deployed as two Workers, each with its own database and buckets: the US one (`flockstack`, [flockstack.io](https://flockstack.io)) and the EU one (`flockstack-eu`, eu.flockstack.io). The top level of `wrangler.jsonc` is the US deployment and `env.eu` is the EU one (Wrangler environments inherit nothing, so it repeats the bindings).

| | United States | European Union |
| --- | --- | --- |
| Worker and address | `flockstack`, flockstack.io | `flockstack-eu`, eu.flockstack.io |
| `FLOCKSTACK_REGION` | `us` (the default when unset) | `eu` |
| D1 database | `flockstack` | `flockstack-eu`, jurisdiction `eu` |
| R2 buckets | `flockstack-images`, `-files`, `-exports` | `flockstack-images-eu`, `-files-eu`, `-exports-eu`, jurisdiction `eu` |
| Amazon SES | `SES_REGION`, `us-east-1` unless set | `eu-west-1` |
| QStash | the US region (`https://qstash-us-east-1.upstash.io`) | the EU region (`https://qstash-eu-central-1.upstash.io`): its own `QSTASH_URL`, token and signing keys |
| Session cookie | `better-auth.session_token`, as before regions | `flockstack-eu.session_token` |
| API keys | `mc_` + 43 characters | `mc_eu_` + 43 characters |

An account lives in exactly one region. Nothing looks across: the sign-in page asks "Where should your data live?" (starting on the visitor's country, from Cloudflare's `cf-ipcountry`: EU and EEA countries, the UK and Switzerland start on the EU), sends the person to the other Worker's sign-in when they pick it, and says "Already have an account in the other region? Sign in there." Passkeys belong to the Worker's host (the `rpID` is `APP_URL`'s host), API keys work at their region's address only, and the account page and the admin header say which region they are in. A browser signed in to both regions keeps two sets of cookies. Accounts can't move between regions yet.

What is stored where, and what leaves the region, is on the docs page `/docs/regions` (`lib/docs/regions.js`). **Wording:** say "data stored in the EU" or "EU-deployable", never "EU-resident", until every subprocessor in that list is verified.

### Deploying both

`node scripts/deploy-all.mjs` builds once (`npx opennextjs-cloudflare build`), applies the migrations each database is missing, then deploys `flockstack` and `flockstack-eu`. `--only us|eu` does one region, `--dry-run` prints every command and runs none, `--skip-build` deploys `.open-next` as it is. Everything the app reads from `APP_URL` is read when a page is served, not at build, so the one build serves both.

Migrations: the SQL in `migrations/` is applied with `wrangler d1 execute <db> --remote --file`, not Wrangler's migrations tracker. Each database keeps the names of the files it has had in a table of its own, `_flockstack_migrations`, and a run applies only the files that aren't in it, each in one command with its record, so running again does nothing. Files `0001` to `0006` were applied by hand: the first run on a database without the table records them without running them (`--baseline 0006`, the default). For a database that has none of them, pass `--baseline 0`. Every migration is applied before the first deploy.

### What the EU Worker needs

The EU Worker starts from nothing: `wrangler secret put <NAME> --env eu` for each secret, or a `vars` entry under `env.eu` for the others. The database and buckets are bound in `wrangler.jsonc`, and `FLOCKSTACK_CLOUD`, `FLOCKSTACK_REGION`, `IMAGES_STORAGE` and `SES_REGION` are already set there.

- **Its own:** `BETTER_AUTH_SECRET` (never the US Worker's: a session must only be valid in its region), `SUPPRESSION_HASH_KEY`, `APP_URL` (`https://eu.flockstack.io`), `ADMIN_EMAILS`, `EMAIL_FROM`, `SENDING_ENABLED`, `CRON_SECRET`.
- **Amazon SES in `eu-west-1`:** `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_AWS_ACCOUNT_ID`, `SES_SNS_TOPIC_ARN` and `SES_TENANT_SNS_TOPIC_ARN`, with the sending identities, the configuration set and the SNS topics created in that region, subscribed to `https://eu.flockstack.io/api/webhooks/ses` and `/ses-tenants`. The same SES or SNS setup can deliver to both Workers: each acknowledges events for accounts that live in the other region (see below).
- **QStash, EU region:** `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, and the 5-minute schedules for `https://eu.flockstack.io/api/jobs/run-automations` and `https://eu.flockstack.io/api/jobs/run-series`.
- **Images and newsletter sites:** `IMAGES_CDN_URL` (a domain on `flockstack-images-eu`), `SHARED_DOMAIN`, `ARCHIVE_CNAME_TARGET` (`sites-eu.flockstack.io`, never the US Worker's) and `ARCHIVE_TRUSTED_HOSTS` for the EU region's own newsletter addresses, and the Cloudflare variables in [Domains on Cloudflare](#domains-on-cloudflare-flockstack-cloud). The exports bucket needs its 8-day lifecycle rule.
- **Billing:** `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET` (or `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`), and for selling, `STRIPE_CONNECT_SECRET_KEY` and `STRIPE_PAYMENTS_WEBHOOK_SECRET`. One Polar or Stripe webhook can feed both Workers, or the EU Worker can have its own endpoint.
- **Optional:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (add `https://eu.flockstack.io/api/auth/callback/google` to the client), `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the same Services ID and key as the US Worker, see [Apple sign-in](#optional)), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `REGION_URL_US` and `REGION_URL_EU` (default to the two addresses above).
- **Analytics:** `POSTHOG_KEY`, the same project key as on the US Worker (see Product analytics below).
- **Support assistant:** nothing to set: `env.eu` has its own Workers AI binding. `SUPPORT_DAILY_LIMIT` and `SUPPORT_EMAIL` are optional (see Support assistant below).

**Webhooks and the other region.** A provider configured once can deliver to both Workers, so each gets events for accounts it doesn't have. Signatures are checked exactly as before. An event for a subscription, customer, connected account, tenant or message with no account in this region is acknowledged with a 2xx and logged at info level (`no such account in this region`), with no alert and no retry. A real failure, such as Polar being unreachable, still answers 5xx and alerts.

## Domains on Cloudflare (FlockStack Cloud)

On Cloudflare, a customer's archive subdomain (`news.example.com`) CNAMEd to FlockStack is refused by Cloudflare's cross-account CNAME block unless it is a [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) custom hostname on the `flockstack.io` zone. With the variables below, FlockStack Cloud creates one for each archive subdomain when the domain is added and each time it's checked (`lib/custom-hostnames.js`, through `lib/cloudflare-api.js`, the only module that calls Cloudflare's API):

- a **custom hostname** on the SaaS zone, with certificate validation over HTTP (Cloudflare completes it on its own once the customer's CNAME is in);
- a **Worker route** `<hostname>/*` on that zone to this region's Worker, so a US account's hostnames are served by `flockstack` and an EU account's by `flockstack-eu`. A single `*/*` route couldn't send each hostname to its own region. A route to the other Worker marks a hostname as the other region's: the domain shows "Used by another FlockStack account" and nothing is created or removed;
- the hostname's id, route and statuses on the Domain. **Check now** reads them: the archive step shows the CNAME to `ARCHIVE_CNAME_TARGET` plus any TXT records Cloudflare asks for, and the archive moves there only once Cloudflare reports the hostname active **and** its certificate active. A moved hostname or a validation that timed out is asked to validate again. Removing the domain, or the account's purge, deletes the route and the custom hostname; if Cloudflare fails, the domain stays until it's removed again.

`ARCHIVE_TRUSTED_HOSTS` (Worker custom domains in the owner's own account, like newsletter.ankur.works) never reach Cloudflare's API and are verified as before. A self-hosted server, or FlockStack Cloud without these variables, keeps checking the customer's CNAME.

| Variable | US Worker (`flockstack`) | EU Worker (`flockstack-eu`) |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` (secret) | the token below | the same token, or one of its own with the same permissions |
| `CLOUDFLARE_SAAS_ZONE_ID` | the `flockstack.io` zone's ID | the same zone's ID |
| `ARCHIVE_CNAME_TARGET` | `sites.flockstack.io` | `sites-eu.flockstack.io` |
| `FLOCKSTACK_WORKER_NAME` | optional, `flockstack` from `FLOCKSTACK_REGION=us` | optional, `flockstack-eu` from `FLOCKSTACK_REGION=eu` |

Each Worker sets its own `ARCHIVE_CNAME_TARGET`, so customers of each region CNAME to that region's name; the route, not the target, decides which Worker serves a hostname.

**One-time setup, by the owner:**

1. In the `flockstack.io` zone, add a proxied DNS record for each CNAME target, with no origin behind it: `sites` AAAA `100::` (proxied) and `sites-eu` AAAA `100::` (proxied).
2. Under SSL/TLS, Custom Hostnames, set the zone's **fallback origin** to one of them, `sites.flockstack.io`, and wait until it shows Active. Cloudflare for SaaS (SSL for SaaS, Basic) is already on for the zone.
3. Create an API token (My Profile, API Tokens, Create custom token) with exactly these permissions, each limited to the zones listed:
   - Zone, **SSL and Certificates**, Edit: `flockstack.io` (custom hostnames).
   - Zone, **Workers Routes**, Edit: `flockstack.io` (each hostname's route).
   - Zone, **DNS**, Edit: the zone of each Worker's `SHARED_DOMAIN` (shared addresses' records, below).
   - Zone, **Zone**, Read: `flockstack.io` and the `SHARED_DOMAIN` zones.
4. Set `CLOUDFLARE_API_TOKEN` as a secret on both Workers (`wrangler secret put CLOUDFLARE_API_TOKEN`, and again with `--env eu`), and the other variables in the table as `vars`.
5. Existing customer domains are set up at their next **Check now**.

**Shared addresses' DNS.** A newsletter without a domain of its own sends from `hello@<slug>.SHARED_DOMAIN`, whose SES records (three DKIM CNAMEs, the return path's MX and TXT) and a CNAME for its website go into `SHARED_DOMAIN`'s zone. With `CLOUDFLARE_SHARED_ZONE_ID` and `CLOUDFLARE_API_TOKEN` set, FlockStack writes them through Cloudflare's API (`lib/shared-dns.js`) instead of the Vercel DNS helper: SES's records DNS only, the website CNAME (to `ARCHIVE_CNAME_TARGET`) proxied so the Worker serves it, each with the comment `flockstack shared address: <slug>`. Publishing again reuses what's there, this slug's own leftovers are updated, a name anyone else's record holds is refused and the slug's new records are taken back; the records go when the slug changes, the newsletter leaves the shared address or the account is purged. A newsletter keeps the driver it was published with, so records the DNS helper made are removed through it. At most `CLOUDFLARE_DNS_DAILY_CAP` shared addresses a day per zone (150, about the helper's 900 records); the cap or Cloudflare's 429 alerts "Shared DNS at its daily cap", a refused token or Cloudflare failing "Shared DNS failing", once each, like the helper's alerts. Each Worker publishes its own SES region's records (the EU's MX is `feedback-smtp.eu-west-1.amazonses.com`), so a newsletter's records match the region that sends it. Each Worker needs:

| Variable | US Worker | EU Worker |
| --- | --- | --- |
| `CLOUDFLARE_SHARED_ZONE_ID` | the zone of the US `SHARED_DOMAIN` | the zone of the EU `SHARED_DOMAIN` |
| `CLOUDFLARE_DNS_DAILY_CAP` | optional, 150 | optional, 150 |
| `DNS_BROKER_URL`, `DNS_BROKER_SECRET` | unset once Cloudflare's are in | unset |

The website of `<slug>.SHARED_DOMAIN` reaches the Worker through one route per region, added once by the owner in the shared zone: `*.<SHARED_DOMAIN>/*` to that region's Worker (`flockstack` or `flockstack-eu`), plus a route with no Worker for each of the zone's own hostnames the wildcard would otherwise catch (`img.flockstack.io/*`, `sites.flockstack.io/*`, `sites-eu.flockstack.io/*`, and `eu.flockstack.io/*` when the EU's shared domain is under `flockstack.io`): a route outranks a Worker custom domain on the same hostname. The `_dmarc.SHARED_DOMAIN` TXT record stays the owner's to add once.

Limits to know: a zone takes 1,000 Worker routes, one per custom hostname here (more needs Workers for Platforms or a `*/*` route with the region decided inside the Worker), and Cloudflare for SaaS bills custom hostnames past the plan's included ones. A customer whose own DNS is on Cloudflare must leave the CNAME DNS-only (grey cloud): a proxied one skips custom hostname routes. Certificate validation goes through the Worker's route, so `worker-entry.mjs` passes `/.well-known/acme-challenge/*` and `/.well-known/pki-validation/*` on customers' hostnames back to Cloudflare untouched.

## Product analytics (FlockStack Cloud)

FlockStack Cloud counts how people use its own pages with PostHog: one project on PostHog US Cloud for both flockstack.io and eu.flockstack.io. It is not part of the open source. It reaches the shared pages only through the site extensions (`components/marketing/SiteExtensions.jsx` and `lib/marketing/site-extensions.js`, whose defaults add nothing), so a self-hosted server has no analytics code in its way. It is configured on each Worker (the key only writes events and is public, so a `vars` entry is fine):

| Variable | |
| --- | --- |
| `POSTHOG_KEY` | The project's public key (`phc_…`). Unset or malformed: nothing loads and nothing renders. Read when a request renders. |
| `POSTHOG_HOST` | Optional, an https address. Default `https://us.i.posthog.com`. |
| `POSTHOG_SESSION_REPLAY` | `true` turns session recording on, with every input and all text masked. Default off. The Privacy page says it is off, so change `ANALYTICS_RULE` in `lib/legal.js` before turning it on. |

**Where it loads.** Only in the layouts of FlockStack's own pages: the docs and the legal pages (a `layout.js` in each folder of `app/(site)`), sign-in, `/welcome` and the signed-in dashboard (`components/LayoutDashboard.jsx`, used by `app/(app)` and `app/(account)`). Never in the root layout, a newsletter's pages and archive (also on their own hosts), unsubscribe, confirm, keep and referral pages, the reader and comment pages, shop and subscribe pages, the recommendations directory, the OAuth consent page or the admin. `tests/analytics-routes.test.mjs` scans every route and fails when a page carries it that shouldn't, or the scrubber's list of untracked paths (`lib/marketing/analytics-privacy.js`) disagrees with the layouts. That list is a second lock: PostHog drops any event from such a page, even if the browser navigates there without a reload. The marketing website loads its own copy of the analytics on its home, product, pricing, comparison, migration and blog pages (`ANALYTICS_PATHS` in its `data/site.js`), under the same consent cookie, and `ANALYTICS_RULE` in `lib/legal.js` names those pages for the privacy policy: change them together.

**Who is asked** (`lib/marketing/analytics-consent.js`):

| Visitor | PostHog |
| --- | --- |
| In the EU, the EEA, the UK or Switzerland (`cf-ipcountry`, the country list in `lib/region.js`), anywhere on eu.flockstack.io, or in a country Cloudflare can't place (`XX`, `T1`) | Only after they accept the banner |
| Anywhere else | On by default; "Cookie settings" in the footer (and on the sign-in page) lets them decline |
| `Sec-GPC: 1`, `DNT: 1`, `navigator.globalPrivacyControl` or `navigator.doNotTrack` | Never, and no banner |

The choice is the first-party cookie `fs_consent` (`accepted` or `declined`, 12 months, `SameSite=Lax`, `Secure`). Before it, nothing is sent and no `ph_` cookie or local storage is written; posthog-js is not even downloaded. Declining deletes them. `fs_goal` is a ten-minute cookie holding the name of a step only the server sees (a new account, a first newsletter, a plan started: `siteExtensions.sendGoalOnNextPage`); the next page reports it and removes it. It is set only while analytics is on. FlockStack never calls PostHog from the server.

**What it collects.** Page views (including route changes), autocapture, device, browser and approximate location from PostHog; for a signed-in person, their user ID as the distinct ID with `email` and `plan` as the person's properties (`person_profiles: "identified_only"`); and four events, `signup_completed`, `newsletter_created`, `campaign_sent` (with `when`: `now` or `scheduled`) and `plan_started`, reported through `reportGoal` (`lib/goals.js`) from client code or the `fs_goal` cookie. Steps in shared markup with a `data-goal` attribute are kept on the autocaptured clicks. Every event goes through `sanitizeEvent` first: query strings and hashes are cut from addresses (a contacts search can hold an email address), and on the dashboard no element text, page title or label leaves, because a link there can be a subscriber's address or an issue's subject. `tests/analytics-privacy.test.mjs` fixes the property names. Session recording, surveys, heatmaps, dead clicks, error tracking and request timing are off.

**Headers.** `next.config.mjs` sets a Content-Security-Policy without `script-src`, `connect-src` or `img-src`, so PostHog's host needs no entry and is allowed on no page in particular. If those directives are ever added, allow `https://us.i.posthog.com` and `https://us-assets.i.posthog.com` only for the routes that carry the analytics.

**Checked in a browser** on a production build with a made-up key: the banner at phone width, nothing downloaded, sent or stored before Accept, the `ph_` cookie and local storage written after it, a decline deleting them, no marker, banner or link on `/recommendations`. **Not checked:** that events reach the real project and show up in it, Global Privacy Control in a browser that sends it (the header and navigator checks are tested), and the project's own settings (retention, autocapture on, GeoIP). The owner sets the retention; `ANALYTICS_RETENTION` in `lib/legal.js` stays a placeholder until then.

## Support assistant (FlockStack Cloud)

A "Help" button on FlockStack's own pages opens a chat that answers from FlockStack's docs. Like the analytics, it is not part of the open source and reaches the shared pages only through the site extensions (`SupportChat`, `siteExtensions.supportAssistant`, `siteExtensions.supportChatPath`, which is `/?support`); the defaults add nothing, and `/api/support/*` answers 404 without them.

- **Where.** Beside `SiteAnalytics`: the docs, the legal pages, sign-in, `/welcome` and the dashboard. Never on a newsletter's pages, the pages readers use, the shop or the admin (`tests/analytics-routes.test.mjs`). It renders only when the Worker has the Workers AI binding (`"ai": { "binding": "AI" }` in `wrangler.jsonc`, top level and `env.eu`), so a server without it shows no button.
- **Answers.** `POST /api/support/chat` (`lib/marketing/support-assistant.js`) searches the docs pages, the API reference, the legal pages, the prices in `lib/plans.js` and the FAQ, chunked by heading and scored with BM25 in memory (`lib/marketing/support-corpus.js`, built on the first question and kept for the isolate). The best 4 chunks go into the prompt with their links, and the answer comes back with the links it cited. The rules (`lib/marketing/support-prompt.js`): FlockStack only, from the excerpts, cite them, say "I don't know" and offer a person, never invent features or prices, never claim an action, never ask for a secret, and treat what people type as data. A question no chunk matches gets "I don't know" without a model call. A signed-in person's plan, region, sending domains and block reason go into the prompt (`lib/marketing/support-context.js`), nothing else of theirs.
- **Model.** Workers AI through AI Gateway's `default` gateway (created on its first request), with `collectLog: false` and `skipCache: true`: `@cf/qwen/qwen3-30b-a3b-fp8`, then `@cf/openai/gpt-oss-20b` if it fails. On [Cloudflare's price list](https://developers.cloudflare.com/workers-ai/platform/pricing/) (read 2026-10-18) Qwen3 30B is $0.051 per million input tokens and $0.335 per million output, gpt-oss-20b $0.200 and $0.300; an answer is about 3,500 tokens in and 400 out, some $0.0003 or 28 neurons, so the 10,000 free neurons a day cover about 350. Never the Anthropic API.
- **Nothing stored.** The conversation is in the tab's `sessionStorage`, sent with each question and cleared on sign-out. The server keeps rate-limit counters only (by IP address and user ID) and logs no message text. "Email a human" sends the conversation and the account email to support only on the person's click (`POST /api/support/email`, signed in, through `sendPlatformEmail` with the person as Reply-To); a visitor gets a `mailto:` link to send it from their own mail app instead. `SUPPORT_CHAT_STORED`, `SUPPORT_CHAT_RETENTION` and `SUPPORT_AI_PROVIDER_NOTE` in `lib/legal.js` say so on the privacy page.
- **Limits.** 12 questions per network in 10 minutes and 60 a day, 30 per person an hour and 80 a day, `SUPPORT_DAILY_LIMIT` a day per Worker for everyone together, and 3 emails to support per person an hour, 6 a day. Questions up to 1,000 characters, 20 messages a conversation.
- **Analytics.** `support_opened` and `support_answered`, counts with no properties; the panel has `ph-no-capture` and session recording blocks `[data-support-chat]`.

| Variable | |
| --- | --- |
| `SUPPORT_DAILY_LIMIT` | Answers a day per Worker, everyone together. Default 300. |
| `SUPPORT_EMAIL` | Where "Email a human" sends. Default `hello@flockstack.io`, the address on the legal pages. |

**Not checked:** a real Workers AI call. The tests replace the binding with a stub, so the answer's quality, the exact output shape of each model (the code reads `response`, `choices` and the Responses API's `output`), Qwen3's `/no_think` switch on Workers AI and the gateway's options are untested against Cloudflare.

## Audio versions

An issue's text is read aloud by ElevenLabs, with the server owner's own account: nothing here is billed to the writer past their plan, and nothing is sent anywhere until a writer clicks Create audio version. The code is `lib/audio.js` (the job), `lib/audio-text.js` (the text), `lib/elevenlabs.js` (the only module that calls ElevenLabs; tests replace it with `tests/stubs/elevenlabs.mjs`), `lib/audio-quota.js`, `lib/audio-serve.js` (byte ranges), `lib/audio-feed.js` (the podcast) and `lib/actions/audio.js` (eight actions, so REST, MCP, OpenAPI, the docs and `/llms-full.txt` have them).

**API shape**, read from ElevenLabs' docs on 2026-10-20: `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` with `xi-api-key`, a body of `text`, `model_id`, `previous_request_ids` (3 at most), `previous_text` (ignored when ids are sent) and `next_text`. A response's `request-id` header names the request for request stitching, which wants ids no older than two hours and doesn't exist for `eleven_v3`. Characters per request: 10,000 for `eleven_multilingual_v2` and `eleven_v4`, 40,000 for `eleven_flash_v2_5`, 5,000 for `eleven_v3`; FlockStack sends at most 2,500 a request (`AUDIO_CHUNK_CHARS`).

### How it works

1. **Create.** `create_audio_version` prepares the text (headings and list items as sentences, links as their words, web addresses as the site, footnotes at the end, pictures, tables, code, embeds, polls and files left out, with one line at the end saying some parts are only in the web version when something real was dropped; an issue with a paywall break is read up to it, with a line saying the rest is for paid subscribers, unless the whole issue is for paid subscribers). It cuts the text between sentences into parts, **reserves** their characters from the month's quota (refused up front with how many are left), keeps the parts in the private `EXPORTS` bucket and publishes the first QStash step.
2. **Steps** (`app/api/jobs/make-audio`). Each step claims the job, reads one part (one request to ElevenLabs, one R2 write, a few database writes), saves where it got to and publishes the next, so a step is short and a step run twice adds nothing: a part already kept isn't read again. Each part is tied to the three before it with their `request-id`s, and hears the start of the part after it (`next_text`); when an id is missing or older than 105 minutes it hears the end of the part before it (`previous_text`) instead.
3. **Failures.** A busy service (429), a 5xx or a network failure is thrown to QStash, which tries again with its backoff, four deliveries in all; the fourth fails the job with `Part 3 of 8 failed: ...`. A refusal no retry changes (a bad key, no credit, text it won't take) fails at once, and a refused key or no credit also alerts the admins (`audio-setup`). Whatever the end, the quota is settled once: the characters really read are used for good, the rest go back. A failed job keeps its parts for up to 7 days, and creating it again with the same text, voice and model goes on from them.
4. **Join.** When every part is kept, one step joins them, byte by byte (every part has the same format and bit rate), into one MP3 in the private `FILES` bucket, streamed through a `FixedLengthStream` so it never sits in the Worker's memory. The length is the size over the bit rate. The old file is deleted once the new one is in, so re-creating an issue after an edit keeps playing the old audio until the new one is ready. The issue's page is refreshed, the `audio.ready` webhook goes out and the email link is set up if the writer ticked it.

### Setting it up (the server's owner)

| | |
| --- | --- |
| `ELEVENLABS_API_KEY` | The secret: `npx wrangler secret put ELEVENLABS_API_KEY`, and again with `--env eu`. Never in the repository or a `var`. |
| `ELEVENLABS_VOICES` | JSON, a list of `{ "id", "name", "description", "previewUrl" }`: the voices writers can pick, each with a sample that costs nothing to play. Unset, the feature is hidden everywhere. |
| `ELEVENLABS_MODEL` | Default `eleven_multilingual_v2`. `eleven_flash_v2_5` is half the price per character. |
| `ELEVENLABS_OUTPUT_FORMAT` | Default `mp3_44100_128`. Only `mp3_*` formats, since the parts are joined byte by byte. |
| `AUDIO_ENABLED` | FlockStack Cloud only: `true` turns it on, once the notice below is over. A self-hosted server needs only the voices and the key. |

Run `migrations/0023_audio.sql` (two tables, `audioversions` and `audiousages`) on each region's database. It uses the buckets you have already: `EXPORTS` for the parts of a job and `FILES` for the finished files, both private; a file leaves them only through `/audio/<slug>.mp3` on the newsletter's host, which checks who may hear it. Account deletion deletes an account's audio.

### What it costs

ElevenLabs bills by the character. On [its API pricing page](https://elevenlabs.io/pricing/api) (read 2026-10-20, in US dollars, taxes excluded) text to speech is $0.08 per 1,000 characters for Multilingual v2, v3 and v4 and $0.04 for Flash and Turbo; about 1,000 characters is a minute. Some third-party price comparisons say $0.10 and $0.05; the page of ElevenLabs is the source used here, and the quotas stay inside 10% either way, since the dearer rate is the one they are sized on.

A plan's whole quota may cost the owner about 10% of the plan's monthly price: `price x 0.10 / 0.00008 = price x 1,250` characters, rounded down (`AUDIO_CHARACTERS_PER_MONTH` in `lib/plans.js`, one number a plan):

| Plan | Monthly price | 10% of it | Characters (about minutes) | Cost at $0.08 per 1,000 |
| --- | --- | --- | --- | --- |
| Starter | $9 | $0.90 | 11,000 (13 min) | $0.88 (9.8%) |
| Growth | $29 | $2.90 | 36,000 (44 min) | $2.88 (9.9%) |
| Pro | $59 | $5.90 | 73,000 (88 min) | $5.84 (9.9%) |
| Scale | $109 | $10.90 | 136,000 (165 min) | $10.88 (10.0%) |
| Max | $299 | $29.90 | 373,000 (452 min) | $29.84 (10.0%) |

An issue for paid subscribers only is heard by a paid reader whose tier can read it (`lib/reader-access.js`), and an issue the newsletter gates by a signed-in subscriber. A yearly plan gets the same each month, so its share of what the customer pays per month is about 12%. The Free plan (`FREE_PLAN`) has none: `AUDIO_CHARACTERS_PER_MONTH.free` is 0, the action is refused with that reason and the dashboard hides the audio card and the Audio page behind a note about plans. The audio characters and the AI requests a day (`aiRequestsPerDay`) are two counters. Characters are counted per account per calendar month in UTC, never above the plan's number: an audio version that doesn't fit is refused before anything is read, and an admin can set an account's own number from `/admin` (**Change limits**, `limitOverrides.audioCharactersPerMonth`). On Flash the same quotas cost half. A self-hosted server has no plans and no limit.

**Bring your own ElevenLabs key: not built.** The code base has an encrypted-credential pattern (`lib/credentials.js`), but it holds secrets FlockStack makes or an admin connects (a tenant's SMTP password, Postmaster Tools' refresh token), never a key a customer types in for a third party: Stripe is Connect and keeps none. A customer's key would be a new kind of secret to store, rotate and explain, so it is left out until the owner decides it is wanted.

### FlockStack Cloud: the sub-processor notice

The terms promise at least 30 days' notice by email before a new sub-processor handles data, and ElevenLabs is one: it gets the text of issues writers choose to convert. So audio versions are off on FlockStack Cloud until the owner does these, in order:

1. Email account owners about ElevenLabs (text of an issue the writer chooses to convert, the United States, text to speech) and deploy this code: `/sub-processors` already lists it, with the date once it is set.
2. Set `ELEVENLABS_NOTICE_SENT_ON` in `lib/legal.js` to the day the email went out (`"2026-11-02"`), and deploy. The page then says it handles data from that day plus 30, the docs page and the privacy policy follow, and `tests/audio-notice.test.mjs` knows the date.
3. After that day plus 30: set `AUDIO_ENABLED=true` (a var on both Workers), `ELEVENLABS_VOICES` and `ELEVENLABS_API_KEY`, and deploy. Until then the dashboard shows nothing of it, the API answers `unavailable`, the audio and feed routes answer 404, and the flag does nothing: `isAudioEnabled()` also needs the notice to be over by `ELEVENLABS_NOTICE_SENT_ON`. `npm test` fails if `AUDIO_ENABLED` is `true` in `wrangler.jsonc` or the environment without a notice date that is 30 days old.
4. Change the changelog entry's title from "coming soon" and its last line when it is live.

### Not checked

No call to ElevenLabs was made: the tests stub it. So the exact bytes of a real response, whether a real MP3's frames play when joined byte by byte (they should: one format, one bit rate, no tags in between), the `request-id` header's presence, the stitching's effect on the voice, the 429 behaviour and the length of a part's request in real time are untested. The `FixedLengthStream` path is tested with a stand-in, not R2, and so are R2's range reads. The feed passes the strict parser in `tests/helpers/xml.mjs` and `xmllint`, but wasn't submitted to Apple Podcasts or Spotify.

## AI writing tools

The editor's AI tools run on Workers AI, the same way as the support assistant but apart from it (`lib/ai.js`, no import of `lib/marketing`, which is FlockStack Cloud's): through AI Gateway's `default` gateway with `collectLog: false` and `skipCache: true`, `@cf/qwen/qwen3-30b-a3b-fp8`, then `@cf/openai/gpt-oss-20b` if it fails. Never the Anthropic API.

- **What they do.** Select text, then the sparkle button in the format menu: rewrite, shorten, expand, fix grammar, friendlier, more formal, punchier, or translate into 13 languages. "Suggest subject lines" and "Suggest preview text" sit beside the two fields (five subject lines and three preview texts from the saved draft; "Test it" adds a subject to the subject line test), and "Draft social posts" is in the campaign's menu and on a sent issue's report (a LinkedIn post and a post for X, with the issue's page link at the end when it has one). A suggestion is a preview the writer replaces the selection with, adds below, tries again or discards; no tool changes the draft by itself, and nothing is ever posted.
- **What the model sees.** Only the text selected, or the issue's draft (Markdown of its HTML, 12,000 characters at most), between markers the rules call data. Never a contact, an address or anything else of a reader, and nothing is kept: the server stores a counter per account per UTC day (`models/AiUsage.js`, deleted after two weeks), not the text. `AI_WRITING_STORED` in `lib/legal.js` says so on the privacy page.
- **Limits.** Requests a day per account: Starter 20, Growth 60, Pro 150, Scale 300, Max 600 (`aiRequestsPerDay` in `lib/plans.js`). The count goes up before the model is asked and comes back down when neither model answered, so a failed request is free; past the limit the answer is `ai_daily_limit` (429) with the hours until midnight UTC. A self-hosted server has no limit unless `AI_DAILY_LIMIT` is set.
- **Hidden without Workers AI.** `"ai": { "binding": "AI" }` in `wrangler.jsonc` (top level and `env.eu`). A server without it shows no AI button, and the actions answer `unavailable`. The buttons also need a plan.
- **API and MCP.** `rewrite_text`, `suggest_subject_lines`, `suggest_preview_text`, `draft_social_posts` and `get_ai_usage`. Skipped for now: AI images and audio versions of issues.

**Not checked:** a real Workers AI call. The tests stub the binding, so the quality of each tool's output, the prompts' effect on Qwen3 and gpt-oss and the counts of tokens a request costs are untested against Cloudflare.

## Stock photos

The editor's image picker has a "Free photos" tab, [Unsplash](https://unsplash.com/developers)'s free API, when `UNSPLASH_ACCESS_KEY` is set; without it the tab is hidden and `search_stock_photos` and `use_stock_photo` answer `unavailable`. The key stays on the server: the browser only calls FlockStack.

- **Unsplash's rules** (`lib/unsplash.js`): photos are hotlinked from the URLs the API returns, never copied; picking one reports the download to Unsplash (`use_stock_photo` reads the photo by its ID from the API first, so a client can't send a URL or a download address); the photo is credited under the picture, "Photo by <photographer> on Unsplash", both linked with `utm_source` (the app's name, `UNSPLASH_APP_NAME`, default `flockstack`) and `utm_medium=referral`; and the results name their photographer.
- **Privacy.** The search words go to Unsplash. A reader's email app or browser loads the photo from Unsplash's servers, which see that request and the reader's IP address: `lib/subprocessors.js` and `lib/docs/regions.js` say so. Copying the file into FlockStack's own storage would avoid it, but Unsplash's guidelines ask for hotlinks.
- **Limits.** 120 searches and 60 picks an hour per key and account. Unsplash's demo tier allows 50 requests an hour across the whole application until Unsplash approves the application for production.

## Legal pages

FlockStack Cloud's terms of service (`/terms`), privacy policy (`/privacy`) and sub-processors (`/sub-processors`) are first drafts written from what the code and the infrastructure do. They are not legal advice: have a lawyer read them. They are linked from the website's footer, the docs' footer and the sign-in page (whose "By continuing you agree" line is the sign-up step), listed in the sitemap and `llms.txt`, and 404 on a self-hosted server. Everything about the company that the code can't know lives in `lib/legal.js` as constants whose placeholders start with `TODO:`, and the pages read from it. While any placeholder is left the pages are hidden: they answer 404, and the footer, the sign-in page, the consent banner, the sitemap, `llms.txt` and the support assistant leave them out (`isLegalPublished()` in `lib/legal.js`). `LEGAL_PREVIEW=true` shows them anyway, for tests and local review only: never set it in production. To see what is left, run

```bash
node scripts/check-legal.mjs
```

which lists the placeholders still left and exits 1 until there are none. `scripts/deploy-all.mjs` lists them too and deploys anyway, since some can only be filled once a deploy is live. `SERVICES_LIVE_CONFIRMED` is the gate for what the pages describe before it exists (Google sign-in, PostHog with the EU consent banner, the support assistant): the owner sets it once they are live, and the next deploy publishes the pages. When the product changes what it stores, sends or shares (a new service, a new kind of data, a new cookie), change `lib/subprocessors.js` and the pages with it.

## Self-hosting

FlockStack runs on Cloudflare Workers, with D1 for data and R2 for images, so the running cost is mostly what your email provider charges. Plan for about an hour, most of it waiting for DNS and for your provider to approve production sending. Self-hosting comes without support: issues are off and setup questions go unanswered.

### What you need

| Service | For | Cost |
| --- | --- | --- |
| [Cloudflare](https://cloudflare.com) (Workers, D1, R2) | Hosting, contacts, campaigns, stats and image uploads | Free tier to start; D1 is 10 GB per database |
| [Amazon SES](https://aws.amazon.com/ses/) or [PostShiba](https://postshiba.com) | Sending | SES: $0.10 to $0.16 per 1,000 emails, depending on its pricing plan. PostShiba: a fixed price per cluster, invite only for now |
| [Upstash QStash](https://upstash.com/docs/qstash) | Background sending and scheduling | Free tier to start (1,000 messages a day), then pay per message. One message sends 50 emails |
| [Upstash Redis](https://upstash.com/docs/redis) (optional) | Rate limits shared by every server instance, faster than the database | Free tier |

Rate limits are counted in D1 and shared by every Worker instance, so Redis is optional. Image uploads go to your R2 bucket, served from a domain you connect to it.

### Environment variables

Set them as Worker secrets (`wrangler secret put NAME`), or as `vars` in `wrangler.jsonc` for the ones that aren't secret.

| Variable | What it does |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs sessions and every link in sent emails. 32+ random characters (`openssl rand -base64 48`), or the server refuses to start. Rotating it signs everyone out and breaks links in emails already sent |
| `SUPPRESSION_HASH_KEY` | Keys the hashes of the never-email list every account shares. 32+ random characters of its own, never `BETTER_AUTH_SECRET`, or the server refuses to start, after an upgrade too. Changing it empties the list |
| `ADMIN_EMAILS` | Comma-separated emails that can sign in and open `/admin` |
| `ALLOWED_EMAILS` | Who else can sign in: addresses and `@domain` entries, comma-separated |
| `EMAIL_FROM` | From address of sign-in codes and alerts, on an identity your email provider verified |
| `APP_URL` | Public URL of the app, no trailing slash, for email links and sign-in |
| `SENDING_ENABLED` | Nothing goes to readers unless it's `true`. Sign-in codes and alerts don't wait for it |
| `SES_*` or `POSTSHIBA_*` | The email provider, in step 4 |
| `QSTASH_*` | Background sending and scheduling, in step 5 |

[`.env.example`](.env.example) lists every variable with what it does, the optional ones included: Google and Apple sign-in, Postmaster Tools, image uploads, Redis, Telegram alerts, the shared domain, billing, and FlockStack Cloud's own.

### 1. Database and storage

1. Install dependencies and log in: `npm ci && npx wrangler login`.
2. Create the D1 database and the R2 bucket, and put their names and ids in `wrangler.jsonc`: `npx wrangler d1 create flockstack`, `npx wrangler r2 bucket create flockstack-images`.
3. Create the tables: `npx wrangler d1 migrations apply flockstack --remote`. The SQL in `migrations/` comes from the models' schemas (`node scripts/docdb-schema.mjs`).
4. For account exports, create a second bucket that stays private, `npx wrangler r2 bucket create flockstack-exports`, and give it a lifecycle rule that deletes objects after 8 days (the dashboard's R2 settings, or `npx wrangler r2 bucket lifecycle add`). Then bind it as `EXPORTS`: uncomment the line next to the `IMAGES` bucket in `wrangler.jsonc`. Exports are built by background jobs, so they need QStash (step 5). Without the bucket, `export_account_data` answers `unavailable`. Post imports keep the uploaded export there too, under `imports/`, until they finish.
5. Connect a domain to the bucket for image uploads (`npx wrangler r2 bucket domain add flockstack-images --domain img.example.com --zone-id <zone>`) and set `IMAGES_CDN_URL` to it.

### 2. Deploy

1. Build and deploy: `npx opennextjs-cloudflare build && npx wrangler deploy`. Add your domain under `routes` in `wrangler.jsonc` (`{ "pattern": "app.example.com", "custom_domain": true }`) or use the workers.dev address.
2. Set `BETTER_AUTH_SECRET`, `SUPPRESSION_HASH_KEY`, `ADMIN_EMAILS`, `APP_URL` and `EMAIL_FROM` with `wrangler secret put`. With a short secret, FlockStack refuses to start and the logs say why.
3. Sign-in codes go out through your email provider once step 4 is done. Until then nobody can sign in with a code.
4. Open `<APP_URL>/signin` and sign in with your email, or add a passkey from the account page afterwards.

Sending stays off until you finish the next steps, so nothing goes out to readers by mistake. `/api/health` answers 200, or 503 with what to fix. Links in your emails use `APP_URL`, so it should be final before your first send.

### 3. Who can sign in

Only the emails you list: `ADMIN_EMAILS` (who can also open `/admin`) and `ALLOWED_EMAILS`, a comma-separated list of addresses and whole domains, like `jane@example.com, @example.org`. It's checked at every sign-in, with a code, Google or Apple, and anyone you take off the list is signed out and loses their API keys at their next request. With both lists empty, nobody can sign in.

Everyone gets an account of their own, with up to 3 newsletters and their contacts and campaigns, and the account's domains and API keys. There's no billing on a self-hosted server: no plans, no limits.

### 4. Email provider

Pick Amazon SES or PostShiba (invite only for now). `EMAIL_PROVIDER` picks one; without it, FlockStack uses PostShiba when `POSTSHIBA_API_KEY` is set and SES otherwise. Every account gets its own tenant there, with its own domains, suppression list and pause switch. FlockStack creates them; you set up the provider account and its events once.

#### Amazon SES

Use one AWS region for everything below (the examples use `us-east-1`). An AWS account just for FlockStack is best: SES reputation and limits are per AWS account.

1. **Request production access.** New accounts are in the sandbox (200 emails a day, verified recipients only). In **Account dashboard > Request production access**, pick Marketing, and explain that readers opt in, that bounces and complaints are suppressed automatically, and that every email has one-click unsubscribe. AWS usually answers within a day.
2. **Create an SNS topic** for events, like `flockstack-ses-events`, and switch it to signature version 2, which signs messages with SHA256 instead of SHA1: `aws sns set-topic-attributes --topic-arn <topic-arn> --attribute-name SignatureVersion --attribute-value 2`. Then **Create subscription** with protocol HTTPS and endpoint `https://<your-app>/api/webhooks/ses`, raw message delivery off. FlockStack confirms the subscription by itself once it's deployed with the variables of step 4.
3. **Create an IAM user for FlockStack** with this policy, then create an access key for it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:GetAccount",
        "ses:CreateTenant",
        "ses:GetTenant",
        "ses:DeleteTenant",
        "ses:TagResource",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
        "ses:UpdateReputationEntityPolicy",
        "ses:UpdateReputationEntityCustomerManagedStatus",
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:DeleteConfigurationSet",
        "ses:PutConfigurationSetDeliveryOptions",
        "ses:CreateDedicatedIpPool",
        "ses:DeleteDedicatedIpPool",
        "ses:GetDedicatedIp",
        "ses:GetDedicatedIps",
        "ses:PutDedicatedIpInPool",
        "ses:PutDedicatedIpWarmupAttributes",
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:DeleteEmailIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

**Dedicated IPs (optional, for the add-on).** FlockStack uses AWS's *standard* dedicated IPs, $24.95 a month each with no minimum commitment. AWS has no API to lease or relinquish one: you request them in the AWS Support Center (SES console > Dedicated IPs > Request dedicated IPs, which opens a Service Quotas case, quota **Desired Dedicated IP**; the same case, with a lower number, relinquishes one), and AWS answers in hours or days. Lease them ahead of time and add them on `/admin` (**Dedicated IPs**: **Import from AWS**, or type the address), which moves each out of SES's default pool into a parking pool (an IP left in the default pool would carry every account's shared mail). The first IPs come with SES's own automatic warm-up on; FlockStack marks each warm-up complete when it assigns it, because it ramps the share of the account's email itself (below). Because SES has no pool per message, an account with an IP has two configuration sets, `mc-<id>` on shared IPs and `mc-<id>-ip` on its own pool, and each email takes one by its id. The share starts at 2% and grows over 30 days to 100% (`lib/ip-warmup-rules.js`); the hourly cron counts a day only if bounces and complaints are under the early-warning level (`WATCH`) and the account sent at least 25 emails that day, else it holds the day. SES allows 50 IP pools per AWS account and region, not adjustable, so at most 49 accounts can have an IP at once (the parking pool takes one). Idle IPs cost the lease whether they send or not; the admin page shows the cost, and the alert `ip-inventory` (Telegram) fires when none is free while someone has bought or is waiting. An account whose IP is taken back (cancellation, lapse, deletion) returns it to the inventory as available with a note that it carries that account's history. IAM actions: the four `Dedicated IP` lines in the policy above. A managed pool from before standard IPs is billed $15 a month by AWS: the admin page lists them with **Delete managed pools**.

4. **Add the variables** and redeploy: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_AWS_ACCOUNT_ID` (the 12-digit account ID) and `SES_SNS_TOPIC_ARN`. Each account's configuration set publishes its events to that topic.
5. **Optional: tenant pauses.** SES pauses tenants that send badly. To block the account in FlockStack too, send SES's tenant status and reputation finding events from EventBridge to a second SNS topic, subscribe `https://<your-app>/api/webhooks/ses-tenants` to it, and set `SES_TENANT_SNS_TOPIC_ARN`.

Sign-in codes and alerts go out through SES from `EMAIL_FROM`, outside every tenant, so its domain has to be verified in the AWS account before your first sign-in: **Identities > Create identity > Domain**, with Easy DKIM. In the sandbox, the addresses you sign in with have to be verified too.

#### PostShiba

PostShiba approves production sending by hand: until then, sends to anyone outside your team answer `kyc_required` (campaigns pause with that reason) and a team can have one cluster.

1. **Team and key.** In API keys, create a full access key: `POSTSHIBA_API_KEY`, with the team id as `POSTSHIBA_TEAM_ID`. Add a payment method (clusters need one).
2. **Clusters.** One `bulk` cluster sends every email: its id goes in `POSTSHIBA_BULK_CLUSTER_ID`. Later, a `transactional` cluster in `POSTSHIBA_TRANSACTIONAL_CLUSTER_ID` takes welcome, confirmation and test emails, so they never wait behind a campaign. Set `SEND_RATE_PER_SECOND` to the bulk cluster's hourly cap divided by 3,600, less what welcome and test emails need when they share it. At a cap, PostShiba answers `throttled`: the batch goes back to the queue and QStash brings it after the hour.
3. **Webhook.** One endpoint for the whole team (no cluster or tenant) at `https://<your-app>/api/webhooks/postshiba` with the events `processed`, `delivered`, `deferred`, `bounce`, `dropped`, `spamreport` and `unsubscribe`. Its secret goes in `POSTSHIBA_WEBHOOK_SECRET`.
4. **Encryption key.** `CREDENTIALS_ENCRYPTION_KEY`, generated once with `openssl rand -base64 32`. It encrypts each tenant's SMTP password, and Postmaster Tools' refresh token.

FlockStack creates the rest: a tenant per account (slug `mc-<accountId>`), an SMTP credential for it on each cluster (one in all on a single cluster), and its domains. Creating credentials and domains and running domain checks share PostShiba's budget of 60 an hour per key; a failed setup is retried at the account's next send.

Sign-in codes and alerts go through a tenant of their own, `mc-platform`, on the transactional cluster. The first one adds `EMAIL_FROM`'s domain there, and the server log lists the two CNAME records it needs; once PostShiba finds them, codes go out. A domain belongs to one tenant at PostShiba, so `EMAIL_FROM` needs a domain or subdomain that no newsletter sends from.

### 5. QStash

1. In the [Upstash console](https://console.upstash.com/qstash), open QStash and copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` if you picked a region other than the default).
2. Add them and redeploy.

QStash calls `APP_URL/api/jobs/...` to send each batch, so the app has to be reachable on the internet. FlockStack checks QStash's signature on every job.

Automations need one schedule, which QStash doesn't create by itself: a cron that calls `APP_URL/api/jobs/run-automations` every 5 minutes. In the Upstash console, open QStash, Schedules, create one with that destination and the cron `*/5 * * * *`, or from a terminal:

```bash
curl -X POST "$QSTASH_URL/v2/schedules/$APP_URL/api/jobs/run-automations" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: */5 * * * *"
```

Each run starts contacts from segments, date fields and stretches without opens, then moves the contacts whose next step is due, a batch at a time, and asks QStash for another run right away while more are due. Without the schedule, automations that start from signups and tags still enroll contacts, but nothing is sent.

Recurring series (an issue made from a feed's new items on a schedule) need their own, the same way: a cron that calls `APP_URL/api/jobs/run-series` every 5 minutes.

```bash
curl -X POST "$QSTASH_URL/v2/schedules/$APP_URL/api/jobs/run-series" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: */5 * * * *"
```

Each run makes the issues of the series that are due, a draft to review or a send, once for each slot however often the job is delivered. Without the schedule, series make nothing.

### 6. Turn sending on

1. In FlockStack, open **Domains** and add the domain your newsletter sends from. Use a subdomain like `mail.example.com`, so your main domain's email is unaffected. Add the DNS records it lists (DKIM, return path, and DMARC if your root domain has none), then click **Check now**.
2. Create your newsletter. The from address must be on that domain, and the postal address shows in every email's footer (anti-spam laws require one).
3. Set `SENDING_ENABLED=true` and redeploy.
4. Write a campaign, send yourself a test, then send. A first send to new contacts goes out in steps by itself; for a new domain, also set a limit to reach your most engaged readers first, and use **Send to more** on the report once the first step looks healthy.

### Optional

- **Google sign-in.** Create an OAuth client (web application) with the redirect URI `<APP_URL>/api/auth/callback/google`, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The allowlist applies, and a Google sign-in joins an existing user only when Google verified that email.
- **Apple sign-in.** A "Continue with Apple" button under Google's, shown only when all four variables below are set. In Apple Developer, under Certificates, Identifiers & Profiles:
  1. **An App ID** with the Sign in with Apple capability.
  2. **A Services ID**, for example `io.flockstack.signin`: this is `APPLE_CLIENT_ID`. Turn on Sign in with Apple for it, with the App ID above as the primary one, and add the domains and return URLs. FlockStack Cloud: `flockstack.io` and `eu.flockstack.io`, and `https://flockstack.io/api/auth/callback/apple` and `https://eu.flockstack.io/api/auth/callback/apple`. A self-hosted server: its own domain and `<APP_URL>/api/auth/callback/apple`.
  3. **A key** with Sign in with Apple, configured for that App ID. Download the `.p8` file (Apple lets you download it once) and note its Key ID. Your Team ID is on the Membership page.
  4. **On each Worker** (`wrangler secret put <NAME>`, and again with `--env eu`): `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`, the `.p8` file's contents (pasted on one line with `\n` for its line breaks works too).

  Apple takes no fixed client secret, only a JWT signed with that key, for 6 months at most. FlockStack signs a fresh one from the key, valid for a day (`lib/apple-signin.js`), so there's nothing to renew; only a revoked key needs a new one. The allowlist applies, and an Apple sign-in joins an existing user only when Apple verified that email. Apple sends the person's name on their first sign-in only: FlockStack stores it then, and never needs it.

  **Hidden emails.** People can hide their address behind one at `privaterelay.appleid.com`, which becomes their account's email. Apple forwards email to it only from domains registered under **Sign in with Apple for Email Communication** (Certificates, Identifiers & Profiles > Services), with SPF passing for them. Register every domain FlockStack's own emails come from: `mail.flockstack.io`, FlockStack Cloud's default sender, and `EMAIL_FROM`'s domain when it's set to another one. Until then, sign-in codes, alerts and export links never reach those people.
- **Gmail's spam rates (Google Postmaster Tools).** It needs the Google sign-in client above, `CREDENTIALS_ENCRYPTION_KEY` and `CRON_SECRET`; without them, or until someone connects, nothing runs.
  1. In the client's Google Cloud project, enable the **Gmail Postmaster Tools API**, and add `<APP_URL>/api/admin/postmaster/callback` to the client's authorized redirect URIs. Its consent screen has to be published (In production): in Testing, Google expires the connection after 7 days.
  2. At [postmaster.google.com](https://postmaster.google.com), add the domain every email is DKIM-signed with: `SHARED_DOMAIN`, which PostShiba's primary domain signing adds to every email, or `POSTMASTER_DOMAIN`. A domain the same Google account verified in Search Console is verified already.
  3. On `/admin`, under **Gmail spam rates**, click **Connect** and allow access with that Google account. Google warns that it hasn't verified the app: it's your own, continue. FlockStack asks for read access to traffic statistics only, and stores the refresh token encrypted with `CREDENTIALS_ENCRYPTION_KEY`.

  Have a scheduler (a Cloudflare cron trigger, or any other) call `/api/cron/postmaster` every day with `Authorization: Bearer <CRON_SECRET>`. It acts on the newest day of Gmail's data once, with the thresholds in `POSTMASTER` (`lib/config.js`). Gmail only reports domains that send to at least 50 Gmail users a day, and a feedback ID once it has enough emails and spam reports, so until then it finds nothing and says nothing. If Google refuses the connection, one alert says so. Every email's `Feedback-ID` is `<campaign or newsletter id>:mc-<accountId>:<kind>:flockstack` (`lib/sending-rules.js`): SES sends it as it is, and PostShiba writes its own in its place, also led by `mc-<accountId>`, so each ID maps back to its account (`lib/postmaster-rules.js`).
- **Image uploads.** On Cloudflare they go to the R2 bucket bound as `IMAGES` (set `IMAGES_STORAGE=r2` and `IMAGES_CDN_URL`, step 1). To use Amazon S3 instead, put an S3 bucket behind CloudFront on a subdomain of your own (like `cdn.example.com`); it takes over new uploads, and images already stored keep their URLs:
  1. Create a private S3 bucket with Block Public Access on.
  2. In ACM, request a certificate for the subdomain in `us-east-1`, validated by DNS. If your domain has CAA records, add `0 issue "amazon.com"`.
  3. Create a CloudFront distribution: the bucket as origin through Origin Access Control (add the bucket policy CloudFront gives you), viewer protocol HTTPS only, the CachingOptimized cache policy, and the subdomain as alternate domain name with that certificate. Point the subdomain at the distribution with a CNAME.
  4. Create an IAM user for FlockStack with this policy, then an access key for it. Deleting an account deletes its images and clears them from CloudFront's cache, hence `s3:DeleteObject` and `cloudfront:CreateInvalidation`:

     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
           "Resource": "arn:aws:s3:::<bucket>/accounts/*"
         },
         {
           "Effect": "Allow",
           "Action": ["cloudfront:CreateInvalidation"],
           "Resource": "arn:aws:cloudfront::<aws-account-id>:distribution/<distribution-id>"
         }
       ]
     }
     ```

  5. Set `IMAGES_S3_BUCKET`, `IMAGES_S3_REGION`, `IMAGES_S3_ACCESS_KEY_ID`, `IMAGES_S3_SECRET_ACCESS_KEY`, `IMAGES_CDN_URL` (like `https://cdn.example.com`) and `IMAGES_CLOUDFRONT_DISTRIBUTION_ID` (the distribution's ID), and redeploy. Builds read `IMAGES_CDN_URL` too.

  Each image gets a name that never changes and `Cache-Control: public, max-age=31536000, immutable`, so CloudFront and browsers keep it for a year. An account's purge invalidates its folder, `/accounts/<accountId>/*`, on the distribution, so CloudFront stops serving its deleted images.
- **Shared rate limits.** Create a Redis database in the [Upstash console](https://console.upstash.com/redis) and add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- **Alerts on Telegram.** Every admin alert is an email to `ADMIN_EMAILS`. The ones that need someone (an automatic account block, the email provider refusing FlockStack's sends or holding a tenant, Gmail's spam rate for the domain reaching 0.1% or Postmaster Tools refusing the connection, sign-in codes, Stripe events, webhooks or background jobs failing, QStash refusing jobs, shared addresses and the DNS helper) can reach Telegram too: create a bot with [@BotFather](https://t.me/BotFather), send it a message, and set `TELEGRAM_BOT_TOKEN` and the chat's id as `TELEGRAM_CHAT_ID`. Each alert goes there at most once every 6 hours. On PostShiba, have a scheduler call `/api/cron/hourly` every hour with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it once `CRON_SECRET` is set): it checks the team's status (a suspension, the approval, clusters at their cap, held tenants) and alerts on what stops sending. Its first run with Telegram set up posts "Telegram alerts are on".
- **Shared domain.** `SHARED_DOMAIN` is how FlockStack Cloud gives every newsletter without a domain of its own an address, `hello@<slug>.SHARED_DOMAIN`, and its website at `<slug>.SHARED_DOMAIN`. FlockStack adds each subdomain at the provider and has its records published, and removed when the slug changes. With `SHARED_DOMAIN`'s zone on Cloudflare, set `CLOUDFLARE_SHARED_ZONE_ID` and `CLOUDFLARE_API_TOKEN` (DNS Edit on that zone) and FlockStack writes them there itself (see [Domains on Cloudflare](#domains-on-cloudflare-flockstack-cloud)). Otherwise a DNS helper does (`DNS_BROKER_URL`, `DNS_BROKER_SECRET`): a Vercel project of its own that holds the Vercel token, so the app never does, and only writes a shared address's records. The helper isn't part of this repository, its DNS has to be on Vercel with `*.SHARED_DOMAIN` on the project, and without it or Cloudflare, DNS automation is off and shared addresses can't be set up. Add one DMARC record for the whole domain yourself: `_dmarc.SHARED_DOMAIN` TXT `v=DMARC1; p=none;`. It can be the app's own domain, as FlockStack Cloud's is `flockstack.io`: slugs can't take `www` or the other names in `lib/reserved-slugs.js`, and those hosts never open a website.

### Comments

Readers comment on a newsletter's web issues, so the newsletter needs its website on. A reader has no account: a signed link in the newsletter's emails, or a one-time link emailed to a subscriber from the issue's page, starts a session for that newsletter in a cookie of its own. Both use `BETTER_AUTH_SECRET` to sign, so rotating it signs everyone out and breaks the links in old emails. The links, the sign-in email and the emails about replies go through the newsletter's own sending path, so they need a verified sender, and are skipped for suppressed addresses and blocked accounts.

The owner's digest of new comments and reports (at most one an hour) goes out right after the first comment of a quiet hour, and the rest wait for the hourly cron: have a scheduler call `/api/cron/hourly` every hour with `Authorization: Bearer <CRON_SECRET>`, as for the checks above. Without it, they wait for the next comment after the hour.

Comments are stored in the same database as the rest of the account (`comments` and `commentreports` tables, `migrations/0008_community.sql`), are in the account export, are deleted with the account, and belong to "Deleted reader" once their contact is deleted.

### Selling products and paid subscriptions

FlockStack takes **no cut** of what you sell. Readers pay your Stripe account, and the only fee is Stripe's own processing fee. Nothing here sets an application fee, and the code refuses to send one (`lib/payments/stripe-api.js`).

1. **A private bucket for the files.** `npx wrangler r2 bucket create flockstack-files`, bound as `FILES` in `wrangler.jsonc`. It must have no public domain and no `r2.dev` access: files only leave it through the download route, behind a signed link (7 days, 20 downloads, dead after a full refund or a chargeback). Products' files are up to 15 MB.
2. **Stripe.** Set `STRIPE_SECRET_KEY` to a secret key of the Stripe account that gets paid. Then add a webhook endpoint at `<APP_URL>/api/webhooks/payments` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`, and put its signing secret in `STRIPE_PAYMENTS_WEBHOOK_SECRET`. This endpoint is apart from the plan billing one (`/api/webhooks/stripe`): Stripe gives each endpoint its own secret. Events are signed (HMAC-SHA256, 5 minute tolerance) and each one is handled once, by its id.
3. **Products and paid tiers.** In the dashboard, **Products** makes a product (title, price, file) and puts it on sale; **Payments** sets a newsletter's paid tier. The same actions are in the API and MCP (`create_product`, `set_product_file`, `update_product`, `list_orders`, `set_paid_tier`, and the rest of the Products, Orders, Payments and Paid subscriptions groups).
4. **The shop on the website.** `/shop`, `/shop/<product>` and `/subscribe` on the newsletter's host. They appear once the account can take payments and the newsletter's website is live (after its first issue).

**On FlockStack Cloud** each account connects its own Stripe account with Stripe Connect (Standard accounts, direct charges): the Payments page opens Stripe's own onboarding, and the account stays the creator's, with their Stripe dashboard for payouts, refunds and disputes. The platform needs `STRIPE_CONNECT_SECRET_KEY` (default `STRIPE_SECRET_KEY`, if it's the same Stripe platform account), a Connect-enabled Stripe platform account, and a webhook endpoint at `<APP_URL>/api/webhooks/payments` that listens to **events on connected accounts**, with the events above plus `account.updated` and `account.application.deauthorized`.

A newsletter has up to 3 paid tiers (`lib/tier-rules.js`), each a Product on the creator's Stripe account with a Price per way to pay (`lib/payments/tier-prices.js`: monthly, quarterly as 3 months, yearly, lifetime as a one-time payment, pay what you want as a custom amount Price). A newsletter from before tiers has one, named Paid subscription with the id `paid`, read from `paidTier` until its owner adds a tier; contacts with no `paidTierId` hold it. A paid subscriber is paid while Stripe says the subscription is active or in its trial, until the end of the period they paid for; a lifetime payment is paid until 2099 unless it is fully refunded. A failed renewal makes them free at once; Stripe's next successful payment brings them back. Every subscription event re-reads the subscription from Stripe, so events arriving late can't leave stale data. **Pledges** (`lib/pledges.js`, `lib/pledge-conversion.js`): on a newsletter whose paid tier isn't open, a reader can pledge a monthly or yearly price. A Checkout Session in setup mode saves a card on the creator's Stripe account with a SetupIntent; nothing is charged and no paid access is given. Starting to charge (`start_pledge_charging`) runs `app/api/jobs/convert-pledges` in QStash steps: every pledger is emailed the day of their first charge (`noticeDays` ahead, 7 by default) with a signed cancel link (`lib/paid-links.js`), then on that day a subscription is created per pledge, off-session, with a Stripe idempotency key and a search for an earlier one, so a retried or doubled step never charges anyone twice. The hourly cron gives a quiet conversion another job. **Offers** (`lib/offers.js`, `lib/offer-rules.js`): a discount is a Stripe coupon on the creator's account (its terms are Stripe's, so they can't change), applied to Checkout with `discounts` (Stripe takes a coupon or promotion codes, so `allow_promotion_codes` is dropped for an offer); the link `/offer/<code>` shows the discounted prices. A reader who signs up through one carries `offerId`, and the reports count those contacts. A trial without a card is Checkout's `payment_method_collection: if_required` with `trial_settings.end_behavior.missing_payment_method: cancel`. **Gifts** (`lib/gifts.js`, `lib/gift-rules.js`): a gift is a one-time Checkout Session; the webhook marks it paid and publishes `app/api/jobs/deliver-gift` for the delivery day (a wait over 6 days is several jobs, and the hourly cron delivers what a job missed and expires what nobody redeemed). Redeeming (`/gift?token=`) gives a `grant` of kind gift on the contact (`lib/grant-access.js`): paid access that sits beside any Stripe subscription. An unredeemed gift expires `GIFT_REDEEM_MONTHS` (12) after it was bought. **Comps and gifts** are a `grant` on the contact (`lib/grants.js`, `lib/grant-access.js`): paid access until a day that sits beside the Stripe subscription. A paying subscription wins while it lasts and the grant takes over after it; a grant ends on its day, because its stored `paidUntil` is its end less the grace for a missed Stripe event, and the hourly cron clears it. Reports count them apart and leave them out of revenue. A paid issue goes only to paid readers through the normal send pipeline (plan limits, pacing, first-send steps, list cleanup, suppression), and a paid reader is never set aside by the list cleanup.

The hourly cron (`/api/cron/hourly`, see Alerts) also backs up the selling jobs: it delivers gifts whose job was lost, marks unredeemed gifts expired, clears comps and gifts that ran out (and sends their `subscriber.downgraded` webhooks) and gives a quiet pledge charging another job. Without it a comp or a gift still stops reaching paid issues on its day, because every audience query reads the end date.

### Sending well

- **Send from a subdomain** (`mail.example.com`), so a bad week doesn't affect your main domain's email.
- **Authenticate everything:** DKIM, SPF through the custom return path, and DMARC on the root domain.
- **Only email people who asked.** Never import a bought or scraped list. If bots fill your forms, keep confirmed opt-in on.
- **Warm up a new domain.** Send to your most engaged readers first, and grow each send over a few weeks.
- **Watch complaints and bounces.** Keep complaints under 0.1% and bounces under 2%. FlockStack pauses a send past 0.08% complaints or 2% bounces, and blocks the account past 0.3% complaints or 5% bounces. Gmail only shows its spam rate in [Google Postmaster Tools](https://postmaster.google.com): connect it on `/admin` and FlockStack holds each account to the same levels there.
- **Make leaving easy.** Every email has one-click unsubscribe headers and a footer link, which Gmail and Yahoo require.
- **Clean your list.** Keep list cleanup on to stop emailing people who never open. New newsletters start with it on.
- **Keep emails under 100 KB**, or Gmail clips them and hides the unsubscribe link.

<details>
<summary><b>Billing, as on FlockStack Cloud</b></summary>

<br>

`FLOCKSTACK_CLOUD=true` is what [flockstack.io](https://flockstack.io) runs with: sign-up open to anyone, a newsletter setup at `/welcome` right after sign-in, every account on the Free plan until it pays for one (no plan to pick before using it), plan limits, and FlockStack's own emails through Resend when `RESEND_API_KEY` is set, else through your email provider. It refuses to start without a way to send those emails, and `/api/health` answers 503 with the reason. Billing is Polar when `POLAR_ACCESS_TOKEN` is set, else Stripe when `STRIPE_SECRET_KEY` is; with neither, accounts can sign up and use the Free plan but nothing can be bought. Set `FLOCKSTACK_CLOUD` for builds too: the public pages read it then.

| Plan | Monthly | Yearly | Emails per month | Active subscribers |
| --- | --- | --- | --- | --- |
| Free | $0 | $0 | 10,000 | 2,500 |
| Starter | $9 | $90 | 25,000 | 5,000 |
| Growth | $29 | $290 | 125,000 | 25,000 |
| Pro | $59 | $590 | 250,000 | 50,000 |
| Scale | $109 | $1,090 | 500,000 | 100,000 |
| Max | $299 | $2,990 | 2,000,000 | 400,000 |

**The Free plan** (`FREE_PLAN` and `FREE_GUARDS` in `lib/plans.js`) is what an account has without a paid subscription, a lapsed one included. It is not a Polar product and nothing sells it: `getAccountPlan` returns it, so every limit reads from the same place. It has 2,500 subscribers, 10,000 emails a month, 1 newsletter, 2 automations besides the welcome email, 1 webhook endpoint, a post import of 100 posts and 200 MB of images, shared sending IPs only (no dedicated IP) and no extra emails: a send that wouldn't fit in the month's emails is refused up front with the numbers (`plan_limit_emails`), never cut. Your own sending and archive domains, polls, surveys, forms, the API and MCP are all there. Its emails (campaign, welcome, automation and referral, not confirmation emails) and its website carry a "Sent with FlockStack" link (`lib/free-plan.js`, `SENT_WITH_URL` in `lib/site.js`) that a paid plan removes: its `account.sentWithLink` is off by default and `set_sent_with_link` (the billing page) turns it on. Its months run on from the day the account was made (`startFreePlanUsage`), and a paid plan that ends starts them from the end of the paid period, once, when the usage is next read (`rollUsagePeriod`); nothing is deleted. An account over Free's limits keeps and reads all it has, the dashboard and billing page say so, and campaigns wait until it is under them or it upgrades. Upgrading is the first purchase's flow: Checkout through `change_plan`, then the webhook. Canceling or a failed payment puts it back on Free.

Guards, because a free plan draws spam: every account's first send goes through the first-send slice check; until an account has sent 3 campaigns that settled for a day with complaints and bounces under the Free watch level and at least 1% opened, each campaign goes to 500 people at most (`getFirstCampaignsProblem`); bounce and complaint levels are lower on Free (`FREE_LIMITS` and `FREE_WATCH` in `lib/config.js`); sign-up is refused for throwaway inboxes (`lib/disposable-domains.js`), more than 3 accounts a day from one IP address, and past 1,000 accounts a day in a region; and an admin can raise any of an account's limits with the account menu's overrides, which also lifts the cap on its first campaigns. Imports have the same checks as before (consent, role and throwaway addresses, suppressions, domains that can't receive email): a list over 500 does not need confirmation emails, as the first-send slice and the cap on first campaigns bound what it can do to the sending reputation.

**Custom plan:** past Max (over 400,000 subscribers or 2,000,000 emails a month) there is no plan to buy. A sixth step after Max in the plans slider (`lib/custom-tier.js`, `components/SliderPricing.jsx`) leads to `/custom`, a public form (`app/(site)/custom`, rules in `lib/custom-rules.js`) that gauges interest: it says plainly what FlockStack doesn't have yet (SOC 2, SSO, audit logs and the rest) and asks which the visitor would need. Requests are `CustomRequest` documents in each region's own database (`lib/custom-requests.js`, migration `0015`), shown with a count of every need at `/admin/custom`, with a status and notes to set. Each new one alerts `ADMIN_EMAILS` (kind `custom-request`, by email only, naming no one) and sends the requester a short confirmation through FlockStack's own email. The hourly cron deletes requests untouched for 2 years, as the privacy policy says. Keep the copy true: nothing on the Custom card or page may claim a feature FlockStack doesn't have (`tests/custom-plan.test.mjs` checks).

`lib/plans.js` is the one place these live. Yearly plans get the monthly allowance every month of the paid year. Every email counts toward the month: issues, tests, welcome and confirmation emails. Over a limit, campaigns stop with a clear message and an upgrade link; signups and confirmation emails keep going.

**Extra emails** (Polar only): a paid plan whose Polar subscription carries the extra emails price keeps sending past its emails, at $0.15 per 1,000, up to a monthly limit the owner sets on the billing page or with `set_extra_emails_limit` (the plan's emails by default, 10 times them at most). The owner is emailed at 80% and 100% of it. Each month's extra campaign, welcome and automation emails are counted in `ExtraEmailUsage` (`lib/extra-emails.js`) and reported to Polar as `flockstack_extra_emails` events, from the send path at most every 5 minutes per account and from the hourly cron; each report's event id is made from the range it covers, so a retry is a duplicate Polar skips. Polar bills them with the plan at the end of the period (monthly for yearly products the script creates; once a year for a yearly product updated in place, whose meter cycle Polar can't change). The Free plan, plans from an admin, Stripe and a plan bought before the price stop at their emails.

**Dedicated IP add-on** (Polar only), sold at cost: $27 a month on Pro, Scale and Max, monthly only, even next to a yearly plan. AWS leases a standard dedicated IP for $24.95 a month and Polar keeps 4% + $0.40, so the price that breaks even is (24.95 + 0.40) / 0.96 = $26.41; $27 nets $25.52, about $0.57 over the lease and no markup (`DEDICATED_IP_PRICE`, `DEDICATED_IP_AWS_MONTHLY_COST` and `POLAR_FEE` in `lib/plans.js`; a test fails if the price ever nets less than the lease). It is a Polar subscription of its own next to the plan's: once it's paid, the webhook gives the account one of the IPs in the inventory (`lib/ip-assignment.js`, the same `setDedicatedIp` as the admin's **Assign an IP**), and takes it back when the add-on ends; a plan dropping below Pro cancels it at its period's end and takes the IP back at once. With no IP free the add-on waits (`dedicatedIp.waitingAt`, the billing page says it is being prepared, usually within 2 business days, and the admins are alerted) and turns on by itself the hour an IP is added, or at once when an admin adds one. See Dedicated IPs below. Welcome emails take room in the month's emails like issues: once they're used up, each one is skipped (its `Message` says why), the owner gets one email that month, and the dashboard says so next to the welcome email, on the overview and on the billing page. They start again when the month resets or the plan grows; the skipped ones aren't sent later. Admin overrides replace a plan's numbers for one account.

Admins can give an account a paid plan at no charge from `/admin` (the account's menu, **Give a free plan**): any of the five, with an optional end date, without Stripe. It works like a paid plan, its emails start over every month from the day it was given, and the billing page and `get_billing` (REST API and MCP) show it. A plan the account pays for takes over while there's one. **End free plan**, or its end date, puts the account back on the Free plan: the data stays.

**With Polar:** create an organization access token (scopes for products, meters, events, checkouts, customer sessions, subscriptions and reading the organization), then run `POLAR_ACCESS_TOKEN=... node scripts/polar-setup.mjs --dry-run` to see what it would do, and again without `--dry-run`. It creates the "Extra emails" meter, then for each of the 5 plans monthly and yearly and the one monthly dedicated IP add-on, finds the product by its metadata (`flockstack_plan`, `interval`, `flockstack_addon`) and updates it in place (name, description, the fixed price and the extra emails price; Polar archives the prices it replaces), or creates it when there's none, and archives the per-plan and yearly dedicated IP add-on products from before the at-cost price (existing subscriptions on them go on); a second run changes nothing. In Polar's settings, turn on **Allow multiple subscriptions** (the add-on is a second subscription; the script says when it's off). Add a webhook at `<APP_URL>/api/webhooks/polar` for the `subscription.*` events and `order.paid`, with API version `2026-10` (what `lib/polar-catalog.js` pins for requests), and set `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (and `POLAR_SERVER=sandbox` while testing). The hourly cron reports extra emails, so it has to run. Switching plans and cancelling happen in Polar's customer portal.

**With Stripe:**

1. **Prices by lookup key.** Create five products (Starter, Growth, Pro, Scale, Max), each with a monthly and a yearly recurring USD price, and give every price its lookup key: `flockstack_<plan>_monthly` and `flockstack_<plan>_yearly`, like `flockstack_growth_yearly`. Checkout finds prices by these keys and refuses one whose amount or interval doesn't match `lib/plans.js`, so no price ID goes in the environment. A plan shows on the pricing pages, the paywall, billing and `get_billing` only once Stripe has both of its prices at those amounts: the app reads them every 10 minutes, and the static pages when they're built, so redeploy after adding one.
2. **Webhook.** Add an endpoint at `<APP_URL>/api/webhooks/stripe` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.paid`. Use API version `2026-09-30.endive` (the one `stripe@23` pins) and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. **Customer Portal.** Turn on payment method updates, invoices, cancellation (at the end of the period) and plan changes between the ten prices. Charge upgrades at once, with prorations invoiced immediately, and schedule downgrades, a lower price or a shorter interval, for the end of the period: otherwise an account can upgrade, send a bigger plan's emails and downgrade before the difference is billed. The billing page's "Switch" buttons open the portal's confirm page for one plan; without plan changes on, they open the portal's home.

Every subscription event re-reads the subscription from Stripe, so events arriving out of order can't leave stale data. Canceled accounts keep their data: sending, signups and the website stop, and everything comes back when they subscribe again.

</details>

## AI agents, REST API and MCP

Create a key on the **API keys** page and send it as `Authorization: Bearer <key>`. Keys start with `mc_`, or `mc_eu_` on an EU region's Worker (see [Regions](#regions)), followed by 43 characters; to find them in code or logs, match `(?<![A-Za-z0-9_-])mc_(?:eu_)?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`. A full access key can do everything the dashboard can; a signups only key can only add contacts, for keys that sit in a website's code. Every key gets 300 requests a minute.

**Add a contact**: `POST /api/v1/contacts`

```bash
curl -X POST https://<your-app>/api/v1/contacts \
  -H "Authorization: Bearer $FLOCKSTACK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"jane@example.com","source":"website","ip":"203.0.113.7"}'
```

**MCP**: connect Claude Code with a full access key. Every action is a tool.

```bash
claude mcp add --transport http --scope user flockstack https://<your-app>/mcp \
  --header "Authorization: Bearer $FLOCKSTACK_API_KEY"
```

ChatGPT, Claude and Grok Bot add `https://<your-app>/mcp` as a connector or custom MCP server and sign in with OAuth: you sign in to FlockStack and allow the app on a consent page, and it gets full access to that account. The **API keys** page lists connected apps and revokes them. They need the server to be reachable over HTTPS from the internet.

`/docs` on your server has every endpoint, the errors, the MCP setup for ChatGPT, Claude, Grok Bot, Claude Code, Codex and Cursor, and the OpenAPI document at `/api/v1/openapi.json`. On FlockStack Cloud, the same at [flockstack.io/docs](https://flockstack.io/docs) and `https://flockstack.io/mcp`.

## Contributing

Read [AGENTS.md](AGENTS.md) first, whether you're a person or an AI agent: how the app is organized, FlockStack Cloud and self-hosting, the rules (no secrets or personal data in code, tests or commits), code style and tests. [SECURITY.md](SECURITY.md) covers what's built in and the known gaps. Issues are off, and pull requests may not be reviewed.

You need Node.js 22+ (local runs and tests use its built-in SQLite):

```bash
git clone <your fork> && cd flockstack
npm install
cp .env.example .env.local   # set FLOCKSTACK_SQLITE=./local.db, BETTER_AUTH_SECRET, SUPPRESSION_HASH_KEY, ADMIN_EMAILS
npm run dev
```

- Without `FLOCKSTACK_CLOUD` it runs as a self-hosted server: sign in with an email in `ADMIN_EMAILS` or `ALLOWED_EMAILS`. Without `RESEND_API_KEY`, development prints the code in the server console (`[signin] Code for ...`); production never does.
- `FLOCKSTACK_SQLITE=./local.db` keeps a local SQLite file instead of D1. To run it on the Workers runtime with local D1 and R2, use `npx opennextjs-cloudflare build && npx wrangler dev` with the secrets in `.dev.vars`.
- To work on FlockStack Cloud's own parts, set `FLOCKSTACK_CLOUD=true` and a way to send its own emails (SES keys, or `RESEND_API_KEY`). For billing, Polar's sandbox (`POLAR_SERVER=sandbox`) or Stripe test keys with `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
- Sending stays off unless `SENDING_ENABLED=true`. SES needs `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`: the app never falls back to `~/.aws` or other default AWS credentials. PostShiba needs its four ids and keys and `CREDENTIALS_ENCRYPTION_KEY`.
- QStash can't reach `localhost`. To try a full send locally, run the QStash dev server (`npx @upstash/qstash-cli dev`) and use the URL, token and signing keys it prints.

Before a pull request, run the full suite, lint and a build:

```bash
npm test       # unit and integration tests
npm run lint
npm run build
```

Each integration test file gets its own in-memory SQLite, and `node scripts/test-all.mjs <log directory>` runs the files in parallel. They import server actions and route handlers as they are, and `tests/setup` replaces every outside service with the stubs in `tests/stubs`, so nothing reaches the network. `tests/parity.test.mjs` fails when an action is missing from the REST API, MCP, the OpenAPI document, the docs or the llms files.

## License

[GNU Affero General Public License v3.0](LICENSE). Copyright (C) 2026 Marc Lou (MailCheap) and FlockStack's contributors.

If you change FlockStack and run it for other people, the AGPL asks you to offer them the source of your version: point the "Source code" link (`SOURCE_URL` in `lib/site.js`) at it. The one-time release before this license, [67d13b0](https://github.com/marclou/mailcheap/tree/67d13b028a6ecae9ec56d49c4b2db58019217eba) in github.com/marclou/mailcheap's history, stays under MIT.

FlockStack is a fork of MailCheap, made by [Marc Lou](https://x.com/marclou).
