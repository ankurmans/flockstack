# FlockStack Cloud: six Workers behind one domain

FlockStack Cloud answers `flockstack.io` and `eu.flockstack.io` with a small router Worker that hands each request to the Worker that can answer it without starting the whole app. The app Worker is a 40 MB script: a new isolate needs one to several seconds to load it, so with few visitors most requests used to pay that. The public pages (the website, the docs, the legal pages) come from Workers that start in milliseconds, and the REST API, the MCP server and the OAuth endpoints MCP clients call come from a lean API Worker of about 8 MB that starts in a fraction of a second; only the dashboard and the other routes that need the app start it. (The app's script is 30 MB, down from 40 MB: `docs/PERFORMANCE.md`.)

**Self-hosted servers have none of this.** A server without `FLOCKSTACK_CLOUD=true` runs from the one app Worker (`wrangler.jsonc`), exactly as before: no router, no public pages Worker, and `worker-entry.mjs` does what it always did. Nothing in this document is needed to self-host, and nothing in it changes what a self-hosted server serves.

## The Workers

```
                     flockstack.io / eu.flockstack.io
                                  │
                       ┌──────────▼───────────┐
                       │  router (a few KB)   │  workers/router
                       └──┬──────┬──────┬──┬──┘
        website paths, and │      │      │  │ everything else
        "/" without a      │      │      │  │ (and whatever fails open)
        session            │      │      │  │
                           │      │ docs, legal pages, llms files,
                           │      │ openapi.json, sitemap, robots, manifest
                 ┌─────────▼┐ ┌───▼──────┐   │      /api/v1, /mcp, OAuth endpoints,
                 │ website  │ │ public   │   │      /.well-known metadata
                 │ (private │ │ pages    │ ┌─▼────────────────┐  ┌▼──────────────────────────┐
                 │  repo)   │ │ (static) │ │ API (8 MB)       │  │ app (30 MB): flockstack,  │
                 └──────────┘ └──────────┘ │ flockstack-api,  │  │ flockstack-eu. Every route│
                              workers/public│ -api-eu          │  │ the product has.          │
                                           │ workers/api      │  └───────────────────────────┘
                                           └──────────────────┘
```

| Worker | Where | What it does |
| --- | --- | --- |
| `flockstack-router`, `flockstack-router-eu` | `workers/router` | Owns the domain. Plain JavaScript, four small imports, about 7 KB. Picks WEBSITE, PUBLIC, API or APP for each request, adds `x-served-by` and `server-timing`, and falls back to APP when WEBSITE, PUBLIC or API fails (API: see below). |
| `flockstack-api`, `flockstack-api-eu` | `workers/api` | The REST API (`/api/v1`), the MCP server (`/mcp`, `/api/mcp`), the OAuth endpoints an MCP client calls (token, introspection, revocation, registration, userinfo, jwks) and the discovery documents (`/.well-known/oauth-*`, `openid-configuration`). The same source modules as the app's routes, built without Next.js or React. Bound to its region's database and buckets. Receives nothing until the router's `API_ENABLED` says so. |
| `flockstack-readers`, `flockstack-readers-eu` | `workers/readers` | What a reader's mail client or browser sends by itself, in bursts when a campaign goes out: the open pixel (`/o/<token>`), the click redirect (`/c/<token>`), unsubscribe (`/api/unsubscribe`, one-click POST included), the archive's beacons (`/api/views`, `/api/visit`, `/api/recommendations/impression`) and the address signup forms post to (`/f/<id>`, `/embed.js`). 2.2 MB, built from the app's own route modules. See below. |
| `flockstack-website` | the website repository (private) | The marketing website. Unchanged: the router asks it for the same paths, with the same host, cookies and `cf-*` headers as before. |
| `flockstack-public`, `flockstack-public-eu` | `workers/public` | The docs, the legal pages and the files for agents and crawlers, rendered once per deploy (`npm run build:public`) and served as files. A script of 3 KB fills in each visitor's analytics settings. |
| `flockstack`, `flockstack-eu` | the rest of this repository | The app. It keeps every route, the API's included, so rolling back is pointing the domain back or switching `API_ENABLED` off. |

Two routers, not one with a table per host, because each has a different APP binding and reads a different session cookie, and a mistake in one region's deploy then stays in that region. The public pages Worker is also one per region: its files contain the names of the JavaScript files of the build its own app Worker runs, so a region deployed alone never serves pages that point at another build's files.

## Where a request goes

`workers/router/routing.js` is the table, and `tests/router.test.mjs` runs it. The router acts only on the app's own host (`APP_URL`, or a `workers.dev` address while it is being tried); a request for any other host goes to APP untouched.

| Request | Goes to |
| --- | --- |
| The website's paths (`FORWARDED_PATHS`: `lib/website-routing.js`, the one list; the router imports that module) | WEBSITE |
| `/` without a session cookie | WEBSITE |
| `/` with a session cookie (`better-auth.session_token` in the US, `flockstack-eu.session_token` in the EU, each with or without `__Secure-`) | APP, the dashboard |
| The docs (every page in `lib/docs/pages.js`), `/terms`, `/privacy`, `/sub-processors`, `/llms-docs.txt`, `/llms-full.txt`, `/api/v1/openapi.json`, `/sitemap.xml`, `/robots.txt`, `/site.webmanifest`, `/icon.svg`, `/apple-icon.png` (`lib/public-routing.js`) | PUBLIC, for a GET or HEAD |
| `/api/v1/*` (every method), `/mcp` and `/api/mcp`, the four `/.well-known` documents of OAuth and MCP discovery, and the machine endpoints of OAuth under `/api/auth` (`/oauth2/token`, `/oauth2/introspect`, `/oauth2/revoke`, `/oauth2/register`, `/oauth2/userinfo`, `/jwks`): `lib/api-routing.js`, the one list, with the groups `rest`, `mcp`, `wellknown`, `oauth`. Only when the router has the API binding and `API_ENABLED` names the group. `/api/v1/openapi.json` stays PUBLIC's for a plain GET | API |
| The reader paths of `lib/reader-routing.js` (`/o/*`, `/c/*`, `/api/unsubscribe`, `/api/views`, `/api/visit`, `/api/recommendations/impression`, `/f/<24 hex>`, `/embed.js`), every method, on the app's host **and on every newsletter's host that reaches the router**, with the groups `tracking`, `unsubscribe`, `beacons`, `forms`. Only when the router has the READERS binding and its secret `READERS_ENABLED` names the group (`READERS_ENABLED_WORKERS_DEV` on a workers.dev address) | READERS |
| Everything else: the dashboard, the rest of `/api` (`/api/auth/oauth2/authorize`, sign-in, callbacks), `/oauth/consent`, other `/.well-known` paths (Cloudflare for SaaS certificate checks), sign-in, readers' pages, webhooks, jobs, QStash, Polar, Stripe, uploads, `/_next/static`, `/custom`, `/recommendations`, and every POST outside the API's paths | APP |

Files of the app's static assets (`/_next/static/*`, `/favicon.ico`, `/icon-192.png`, `/icon-512.png`) go to APP too, and the platform answers them from the assets without starting the app's script (measured on a deployed stack: no `x-iso-app` header). `public/_headers` makes the hashed files under `/_next/static` immutable for browsers, which Cloudflare's static assets did not do by themselves (they sent `max-age=0, must-revalidate`, so every page asked again for every script).

**Fail open.** WEBSITE and PUBLIC get three seconds (`ROUTER_TIMEOUT_MS`) to start answering. If one throws, times out, answers 502, 503 or 504, or (PUBLIC) says it has no copy of the page, the router asks APP, which still has every route. Only a GET or HEAD is ever retried. What WEBSITE or PUBLIC answered otherwise, a 404 included, is the answer: a legal page that is not published yet is a 404 on purpose.

**API fails open only where that is safe.** A GET, HEAD or OPTIONS to the API Worker gets ten seconds (`ROUTER_API_TIMEOUT_MS`) and then, like the pages, the app answers if the API Worker threw, timed out or answered 502, 503 or 504 (or said `x-fs-api-miss`, a path that is not its own). A POST, PATCH, PUT or DELETE is sent once, never timed out and never sent again: by the time something fails it may have been carried out, and a retry could send a campaign twice. A failure then answers `502 {"error":{"code":"unavailable","message":...}}`. The one exception is the API Worker itself saying that it did nothing (`503` with `x-fs-api-unprocessed`: `API_DISABLED=true` on it, or no database bound), before it reads a body: the router copied the request beforehand if its body was 1 MiB or smaller (`MAX_REPLAY_BYTES`) and asks the app with that copy, bytes and signature headers as they came; a bigger body is not copied, and the 503 is the answer. The kill switches: `wrangler secret delete API_ENABLED` on the router (seconds, no deploy) or `API_DISABLED=true` on an API Worker.

**https first, and no www.** A request for plain `http://flockstack.io` (or `http://eu.flockstack.io`) is answered by the router itself with a 308 to the same path and query on https, and `www.flockstack.io` with a 308 to `https://flockstack.io` (any method: a 308 keeps the method and the body for a client that follows it, so an API call or a webhook sent to http or to www is not changed, only sent on; a client that does not follow redirects, as some webhook senders do not, gets the 308 and must use the https address. Only a GET or HEAD redirect is cached, for an hour) (`chooseRedirect` in `workers/router/routing.js`; no Worker is started). `env.us` holds `www.flockstack.io` as a second custom domain; the EU router has no `www.eu` and the same rule would apply if it ever did, which makes Cloudflare create its proxied DNS record; deploying that environment is the step that turns the redirect on (check first that the zone has no DNS record for `www` of its own: Cloudflare creates one for a custom domain, and refuses or replaces an existing one). Certificate checks under `/.well-known/acme-challenge/` and `/.well-known/pki-validation/` are never redirected. This is in addition to the zone's "Always Use HTTPS" setting, not a replacement: pages the router does not see (a newsletter's own domain) are the zone's. It does nothing for a `workers.dev` address (a router being tried has its own as `APP_URL`), and every response on a `workers.dev` host carries `x-robots-tag: noindex, nofollow`. API paths are redirected like any other: `http://flockstack.io/api/v1/...` and `https://www.flockstack.io/mcp` end up on `https://flockstack.io` before the API Worker is asked.

**The website's own files are not handed to the app.** Under `/_website/` (scripts, fonts, social cards, the manifest) the app has no copy, so its answer for a file the website was slow to start would be a 404 that a crawler keeps as the card's answer. The router asks WEBSITE again, for ten seconds (`ROUTER_ASSET_RETRY_MS`), and then answers `503` with `Retry-After: 5` and `no-store`. Pages still fail open to the app as above.

**Nothing is rewritten on the way to APP or API.** The app gets the visitor's own `Request` object: method, URL, headers (cookies, `cf-connecting-ip`, `cf-ipcountry`, webhook signatures) and the body as a stream the router never reads. Standard Webhooks and Stripe signatures cover the exact bytes of the body, and they arrive as they were sent. Responses come back with their status, redirects, cookies and body stream untouched, plus `x-served-by` (`router`, `website`, `public`, `api` or `app`) and `server-timing` (`router;dur=` is the whole time in the router; `app;dur=` or `api;dur=` is the Worker's own handler, without starting its isolate, and `app-wait;dur=` or `api-wait;dur=` is how long the router waited for it, a cold start included).


**Next.js asks for the data of a page when a link comes into view or is clicked.** A docs page has twenty links, so without care each visit to a public page would start the app for those requests. When such a request is for a page WEBSITE or PUBLIC serves, or is made from a public page, the router answers it itself: a prefetch gets a 204 (Next.js drops it), and a click gets a short HTML page, which Next.js cannot read as page data and so loads the address as a plain page, served from PUBLIC. The click on a docs link is therefore a normal page load of a static file.

**The router's own address:** `/__router/health` answers `200 ok` with `x-served-by: router`. `scripts/deploy-all.mjs` uses it to see whether the router holds a domain.

## The API Worker

`workers/api` serves what the REST API, MCP and the OAuth endpoints need and nothing else: no Next.js, no React, no server components. One implementation, not a copy: `scripts/build-api-worker.mjs` bundles the **same route modules** the app serves (`app/api/v1/[...path]/route.js`, `app/mcp/route.js`, `app/api/mcp/route.js`, `app/.well-known/*/route.js`, `app/api/auth/[...all]/route.js`) with esbuild, and `workers/api/handler.js` calls them the way Next.js does (`API_ROUTES` is the table; `tests/api-routing.test.mjs` keeps it equal to the files of `app/`). The shared code imports a few Next.js and OpenNext modules, and the build puts small adapters in their place (`workers/api/shims`): `next/headers` and `next/navigation` throw if a request-scoped call is ever made (Better Auth's cookie plugin reads that as "no request scope" and does nothing), `react`'s `cache` is the function itself, `@opennextjs/cloudflare`'s `getCloudflareContext` returns the Worker's bindings, and `lib/runtime-hooks.js` (`revalidatePath`, `after`) is replaced by `workers/api/runtime-hooks.js`.

**Agent safety is the same code.** The guard (`lib/agent-guard.js`: key scopes and levels, one newsletter per key, daily caps, expiry, the approval queue and its 202 / MCP `approval_required` answer, `get_approval_status`, the activity log, OAuth access levels from the consent) runs inside `runAction`, which the API Worker's routes call like the app's, so nothing is copied; the agent-safety suites run against the Worker too (`tests/api-worker-parity.test.mjs`). Its heavier dependencies (alerts, webhooks) load only when an approval is created or decided.

**Cache invalidation.** An action in the API Worker that drops a page (`revalidatePath`) cannot do it itself; it notes the page and, when the response is complete (an MCP tool's, when its stream ends), sends one signed request to the app over the `APP` service binding: `POST /api/internal/revalidate`, signed with a key derived from `BETTER_AUTH_SECRET` (`lib/internal-revalidate.js`), refused if older than five minutes or naming anything but the archive and campaign pages the shared code revalidates. The app drops them. A failure is logged and nothing else, as with the app's own revalidation. `after()` is `ctx.waitUntil`.

**Secrets and bindings.** Secrets belong to one Worker, so `flockstack-api` and `flockstack-api-eu` each need their own copy of what the app has for the routes they serve: `node scripts/api-env.mjs` lists the variables the bundle reads (at least `BETTER_AUTH_SECRET`, `SUPPRESSION_HASH_KEY`, `APP_URL`, `UPSTASH_*`, `STRIPE_SECRET_KEY`, `SES_*`, `QSTASH_TOKEN`, `POLAR_ACCESS_TOKEN`, `IMAGES_*`, `EMAIL_*`), and `workers/api/wrangler.jsonc` binds the region's D1 database and R2 buckets, Workers AI and the app. It has no routes, no `workers.dev` address and no cron: only the router reaches it.

**What it costs to start.** About 7.8 MB of script, against the app's 30 MB. Each group of routes loads its code on its first request, not at start (`dynamic import`), and inside the REST API the file of actions for the one action asked for (`lib/actions/manifest.js` knows every action's route; `lib/actions/lazy.js` loads the file on demand), Better Auth only for OAuth, the AWS clients only when used. Measured numbers: `docs/PERFORMANCE.md`.

**Parity.** `FLOCKSTACK_API_TARGET=worker npm test` runs the whole suite with every API, MCP and OAuth request going to the Worker's `fetch` handler instead of the Next.js route (`tests/helpers/app.mjs`, `callRoute`); `npm test` runs the nine suites that matter most that way as well (`tests/api-worker-parity.test.mjs`) and compares the two answer for answer for every action (`tests/api-worker.test.mjs`).

## The readers Worker

`workers/readers` serves the reader's own requests that need no page rendered, from the same route modules as the app (`app/o`, `app/c`, `app/api/unsubscribe`, `app/api/views`, `app/api/visit`, `app/api/recommendations/impression`, `app/f/[id]`, `app/api/embed-script`), built by `scripts/build-readers-worker.mjs` with the API Worker's esbuild step, shims and runtime hooks. It is 2.2 MB against the app's 28: a campaign to a big list makes every mail client open the pixel and every reader click, in a burst, and each cold start of the app for that was 1.5 to 4 seconds of a redirect a reader waits for.

**What stays with the app, and why.** The pages (`/unsubscribe`, `/confirm`, `/preferences`, `/poll`, `/survey`, `/pledge`, `/gift`, the archive, `/embed/<id>`) render React. `/confirm`'s button and the archive's own subscribe form are Next.js server actions, whose ids only Next.js can answer. `/reader/in` sets a session cookie through `cookies()`. The RSS feeds, sitemaps and `/p/<slug>` are reached by the proxy's host rewrites (`proxy.js`) and the edge cache of `worker-entry.mjs`. None of those is the readers Worker's; the unsubscribe page's form posts to `/api/unsubscribe`, which is.

**Newsletters' hosts reach the router only if their route points at it.** The links in a newsletter's emails are on its own host (`lib/archive-hosts.js getLinkBaseUrl`): `<slug>.SHARED_DOMAIN` through one wildcard route per region, or a customer's domain through a Cloudflare for SaaS custom hostname with a route `<host>/*` of its own (`lib/custom-hostnames.js`). Those routes name the app Worker, so the router never saw them, and the readers Worker would receive only requests to `flockstack.io` itself (almost none). `node scripts/route-archive-hosts.mjs --to router` lists, and with `--apply` moves, every route that names `flockstack` or `flockstack-eu` to `flockstack-router` or `flockstack-router-eu` (patterns kept); `--to app --apply` puts them back. The router sends anything that is not a reader path on those hosts to the app untouched, exactly as the route did, so the cost for the rest of the archive's traffic is one hop through a Worker that starts in milliseconds. After the move, `FLOCKSTACK_WORKER_NAME` on each app must be its router's name: `lib/custom-hostnames.js` compares a host's route with it, and treats a route that names another Worker as another region's. A newsletter's hosts with a *Worker custom domain* on the app (`newsletter.ankur.works` in `wrangler.jsonc`) are not routes and stay with the app.

**Same links, same answers.** The tokens in links already sent are signed with `BETTER_AUTH_SECRET` (`lib/tracking.js`, `lib/unsubscribe.js`, `lib/confirmation.js`: HKDF-SHA256 and HMAC, nothing about the host or the Worker). The readers Worker needs the value the region's app has; with another one every link in an inbox fails (an open is not counted, a click shows the "Continue" page, unsubscribe says the link is invalid). `tests/readers-worker.test.mjs` signs links the way a sent email carries them, with its own code, and has the Worker accept them. `SUPPRESSION_HASH_KEY` likewise. Rotating them on the app, the API Worker and the readers Worker together, with the old values kept as `*_PREVIOUS` so those links keep working, is `scripts/rotate-auth-secret.sh` (`docs/AUTH-ROTATION.md`). `node scripts/readers-env.mjs` lists what each endpoint reads; the pixel and the click need only `BETTER_AUTH_SECRET` and the database. `bash scripts/set-reader-secrets.sh us eu` asks for the rest.

**Fail open, never twice.** Like the API: a GET, HEAD or OPTIONS gets five seconds (`ROUTER_READERS_TIMEOUT_MS`) and then, if the Worker threw, was slow, answered 502, 503 or 504, or said `x-fs-readers-miss`, the app answers. A POST is sent once and never again, except when the Worker says `x-fs-readers-unprocessed` (it is switched off with `READERS_DISABLED=true`, or has no database): then the app is asked, with the body copied beforehand when it is under 1 MiB. A click that failed over to the app after the readers Worker recorded it is counted twice in the click totals (the per-message record is idempotent): rare, and the redirect is what matters.

**Parity.** `FLOCKSTACK_READERS_TARGET=worker npm test` sends each reader request to the Worker's `handleReaderRequest` instead of the Next.js route (`readerRoute` in `tests/helpers/app.mjs`); `npm test` runs the eleven suites that matter that way too (`tests/readers-worker-parity.test.mjs`). `tests/readers-worker-build.test.mjs` loads the built bundle against a shared database file, so what runs is what Wrangler uploads.

## What does not go through the router

- **A newsletter's own domain and the shared archive hosts** (`<slug>.<SHARED_DOMAIN>`) keep their Cloudflare for SaaS hostnames and Worker routes straight to the region's app Worker (`lib/custom-hostnames.js`, `lib/cloudflare-api.js`, the `sites.flockstack.io` fallback origin) **until `scripts/route-archive-hosts.mjs` moves them to the router** (above, and Runbook 6). While they name the app, `FLOCKSTACK_WORKER_NAME`, if the app has it set, must keep naming the app Worker; once moved, it must name the router. And `newsletter.ankur.works` stays a custom domain of the app in `wrangler.jsonc`.
- **Cron.** The app's two cron triggers stay on the app Worker and call the app's own handler.
- **Webhooks, QStash, Polar, Stripe** keep calling `https://flockstack.io/...` and pass through the router to APP as they are.

### The edge cache for newsletters' public pages

A newsletter's public pages also suffer cold starts, and they are customers' websites, so `worker-entry.mjs` keeps them in the data center's cache (`lib/edge-cache.js`, the cache it already used for FlockStack's own docs). The pages: the home page, the list of issues, an issue (`/p/<slug>`), a tag, an author, the links page, `sitemap.xml`, `robots.txt`, `llms.txt`, `feed.xml` and `podcast.xml`. The rules:

- A plain GET with no query and no cookie of the visitor's own (Cloudflare's `__cf_bm`, `_cfuvid` and `cf_clearance` do not count). Any session or reader cookie goes to the app. Forms, shop pages, offers, sign-in, the Subscriber Center and every link an email carries are never cached.
- Only a 200 of a text, JSON, XML, RSS or Atom type without `Set-Cookie` is stored. A feed reader that sends `If-None-Match` with the ETag of the stored copy gets a 304 with no body, as it does from the app. A 404 for an unpublished issue, a redirect and an error are not.
- The key is the host, the path and the Worker's version, so a deploy empties the cache.
- Fresh for 60 seconds. After that the stored copy still answers while a new one is fetched behind it, for up to 10 minutes. The response says `x-edge-cache: HIT`, `STALE`, `MISS` or `BYPASS`.

**There is no purge.** The Cache API keeps a copy in each data center and nothing can reach them all, so what bounds how long an old page can be shown is the ten minutes. An issue an author unpublishes or edits, or a new issue on the home page, can take up to ten minutes to change for a visitor who has not been served a fresh copy. A deploy clears everything. The archive's own revalidation after a send reaches the app's render, not the stored copies. If ten minutes is too long for a takedown, lower `ARCHIVE_STALE_SECONDS` in `lib/edge-cache.js` or take `/p/` out of `ARCHIVE_PATTERNS`.

On `workers.dev` the Cache API does nothing, so `x-edge-cache` can only be seen on a custom domain.

FlockStack's own docs and legal HTML are no longer stored there where `POSTHOG_KEY` is set: the analytics component decides per visitor, from their country and privacy signals, whether the consent banner is asked for, so one visitor's page was being served to the next. The public pages Worker serves those pages with the decision made per request; the files without HTML (robots.txt, sitemap.xml, the OpenAPI document, llms) are still cached.

## The public pages

`npm run build:public` (`scripts/build-public.mjs`) builds the app with OpenNext, starts the built Worker locally in workerd for each region with that region's settings and dummy secrets, and asks it for every path in `lib/public-routing.js`. What the app answers is written to `workers/public/dist/assets/<region>/` and listed in `workers/public/dist/manifest.json` with its status and headers: a page is what the app renders, a legal page that is not published included (a 404 with the app's 404 page). The build stops if a page answers anything but 200 (or the legal 404), is cut off, or has no heading. `npm run render:public` does the second half when `.open-next` is already built.

Both regions are rendered from one build, with `APP_URL`, `REGION_URL_US` and `REGION_URL_EU` from `lib/region.js`. They differ where the app does: the address in the examples and the sitemap, and the canonical address (the EU Worker's pages are indexed at the US address; `lib/site-origin.js`).

**What differs per visitor.** The analytics component (`components/marketing/SiteAnalytics.jsx`) passes the browser the project key, whether the visitor must accept analytics first (their country, or any visitor of the EU deployment), and the consent they saved in `fs_consent`. While the pages are rendered for files (`FLOCKSTACK_PRERENDER=true`, set by the build script and nothing else, `lib/prerender.js`) it prints five markers instead. The public pages Worker puts the values in as it serves the page (`workers/public/handler.js`), by the rules the app uses (`lib/marketing/analytics-consent.js`: `tests/public-worker.test.mjs` checks them against the app's own output for every region, country and saved choice). A Global Privacy Control or Do Not Track signal is read by the browser, as it always was. The help chat is rendered as FlockStack Cloud shows it, so it needs no key.

**What the public Worker needs:** `POSTHOG_KEY` (and `POSTHOG_HOST`, `POSTHOG_SESSION_REPLAY` where the app has them), set as secrets, the same as the app's. Without a key the pages carry no analytics.

`tests/public-parity.test.mjs` compares the text of each docs and legal page as the app renders it in a test with the file in `workers/public/dist` (skipped while the files are not built). `node scripts/verify-public.mjs --app <origin of the app> --public <origin of the public Worker> --region us|eu` compares what the public Worker serves with what the app renders now, for every public path and five visitors (no country, US, Germany, France having accepted, Japan having declined): status, headers and the page's content, taking out only what is timing in React's streaming. Run it against the same build of both. Both regions passed against local Workers and against a deployed stack of Workers on Cloudflare.

### Rendering and `workers/public` for someone else

The two scripts are for FlockStack Cloud's pages: the build always renders with `FLOCKSTACK_CLOUD=true`. Someone who runs their own copy as a cloud, with their own domains, edits the names and addresses in `workers/router/wrangler.jsonc`, `workers/public/wrangler.jsonc` and `lib/region.js`, then runs `npm run build:public`, `npm run deploy:public` (and `-- --env eu`) and `npm run deploy:router`. A server that is not a cloud has no reason to: its docs are served by its app.

## Deploying

`node scripts/deploy-all.mjs [--only us|eu] [--skip-build] [--dry-run] [--skip-router-check]`

For each region, in this order: the app (`wrangler deploy`), the API Worker (`--config workers/api/wrangler.jsonc`, `--env eu` for the EU: it asks the app to drop pages, so the app goes first, and the router binds it, so it must exist before the router), the readers Worker (`--config workers/readers/wrangler.jsonc`, `--env eu`; same reasons), the public pages Worker (`--config workers/public/wrangler.jsonc`, `--env eu` for the EU), then the router. The build, the rendering, the API and readers Workers' builds and the size budgets (`perf-budgets.json`, `npm run perf:budget`) run once first. Deploying the API or readers Worker sends it nothing: the router does, when `API_ENABLED` or `READERS_ENABLED` says so. The website Worker is deployed from the website repository, before anything here. A deploy of the app and of the public pages Worker is not one step: for the seconds between them a visitor who loads a docs page gets a page that points at JavaScript and CSS files of the old build; deploying the app first keeps that window short and in the pages' favour (the files of the new build exist).

`wrangler deploy` takes a custom domain back or drops it according to the routes in `wrangler.jsonc`, and a domain belongs to one Worker at a time. So deploy-all first asks the region's `/__router/health` and compares with `wrangler.jsonc`: if the router answers and the app still lists the domain it stops (the deploy would take the domain back from the router); if the router does not answer and the app no longer lists the domain it stops (the deploy would leave the domain with no Worker). While the app still lists the domain, the router is deployed *staged*: on `workers.dev` only, without the domain.

## Runbook

Nothing here was run against production by whoever wrote it. Run each step, check, then go on. `$SUB` is the account's workers.dev subdomain, `R` the staged router's address.

### 1. Stage (nothing live changes)

1. Deploy the website Worker if its repository has changes (nothing is needed for the router: it calls it with the same paths).
2. `npm ci`, then `node scripts/deploy-all.mjs --dry-run` and read the plan.
3. `node scripts/deploy-all.mjs --only eu`, then `--only us`. This builds, renders, applies migrations that are missing, deploys the new app (which also starts the archive pages' edge cache: check `x-edge-cache` on a newsletter's domain with `curl -sI`, twice), deploys the public pages Worker and the *staged* router. The domains are still the apps'.
4. Set the public Workers' secrets: `npx wrangler secret put POSTHOG_KEY --config workers/public/wrangler.jsonc` (and `POSTHOG_HOST`, `POSTHOG_SESSION_REPLAY` if the app has them), then the same with `--env eu`.
5. Try the staged routers on `workers.dev`. A `workers.dev` address is routed like the domain, and a request that reaches the app goes to the real app, so use GET only.

```sh
R=https://flockstack-router.$SUB.workers.dev                     # EU: flockstack-router-eu
curl -sI $R/__router/health | grep -i x-served-by                # router
curl -sI $R/pricing | grep -i x-served-by                        # website
curl -sI $R/ | grep -iE 'x-served-by|^HTTP'                      # website: a visitor
curl -sI -H 'cookie: better-auth.session_token=x' $R/ | grep -iE 'x-served-by|location'   # app: the dashboard sends to /signin
for p in /docs /docs/api /terms /privacy /sub-processors /robots.txt /sitemap.xml /llms-docs.txt /llms-full.txt /api/v1/openapi.json /site.webmanifest; do
  curl -s -o /dev/null -w "$p %{http_code} %{time_total}s\n" -D - $R$p | grep -iE 'x-served-by|^/'; done
curl -s $R/llms.txt | head -20                                   # the website's part, then the docs part
curl -sI $R/signin | grep -i x-served-by                         # app
curl -sI $R/api/health | grep -i x-served-by                     # app
curl -sI -H 'rsc: 1' -H 'next-router-prefetch: 1' -H 'next-url: /docs' "$R/docs/api?_rsc=x"   # 204, router
node scripts/verify-public.mjs --app https://flockstack.$SUB.workers.dev --public https://flockstack-public.$SUB.workers.dev --region us
node scripts/verify-public.mjs --app https://flockstack-eu.$SUB.workers.dev --public https://flockstack-public-eu.$SUB.workers.dev --region eu   # only if the EU app has a workers.dev address
```

6. A page of the staged router in a browser: `/docs/webhooks` loads styled, the consent banner shows for a visitor without a country (and not where `cf-ipcountry` is `US`), the help button is there, and a click on a docs link is a normal page load.

### 2. Cut over the US

Check `curl -sI https://flockstack.io/__router/health` first (it should be the app's 404, no `x-served-by: router`).

```sh
npx wrangler deploy --config workers/router/wrangler.jsonc --env us        # adds flockstack.io as a custom domain of the router
```

Wrangler sees that `flockstack.io` is already a custom domain of `flockstack` and either asks to move it or refuses; answer yes in a terminal, or move it in the dashboard (Workers & Pages, `flockstack-router`, Domains, Add custom domain). Unverified: how many seconds the swap takes. The DNS record Cloudflare keeps for a custom domain and its certificate do not change, so it should be a switch of what answers, without a gap.

Right away:

```sh
curl -sI https://flockstack.io/__router/health | grep -i x-served-by          # router
```

and the list above against `https://flockstack.io`, plus:

- signed out, `/` is the website (`x-served-by: website`); with a real session cookie in a browser it is the dashboard (`x-served-by: app`); sign in and out in a browser;
- `/pricing`, `/docs`, `/terms`, `/llms.txt` (merged), `/sitemap.xml`, `/robots.txt`, `/api/v1/openapi.json`, `/signin`;
- a webhook with its raw body: Polar's "send test event" and a Stripe test event reach the app and are accepted (`npx wrangler tail flockstack --format json`), a request with a wrong signature gets the same 4xx through the router as at `https://flockstack.$SUB.workers.dev`;
- a newsletter's own domain is still served by the app directly (no `x-served-by`; `x-edge-cache` shows on its public pages);
- `npx wrangler tail flockstack-router` shows no `[router] ... the app answers` lines in steady state.

Then, in this repository, take the `flockstack.io` route out of `wrangler.jsonc` (the first `routes` entry: keep `newsletter.ankur.works`), commit, and from then on `deploy-all` deploys the routers that hold the domains.

**Rollback, under two minutes.**

- A bad router version: `npx wrangler rollback --config workers/router/wrangler.jsonc --env us` (the router before it, in seconds).
- The router itself, or anything about it: give the domain back to the app. Dashboard: Workers & Pages, `flockstack`, Domains, Add custom domain, `flockstack.io` (it moves from the router); or with the API, `PUT /accounts/<account id>/workers/domains` with `{"hostname":"flockstack.io","service":"flockstack","environment":"production","zone_id":"<zone id>"}` and an API token that can edit Workers routes (check the body against the API reference before relying on it). The app has every route and needs no deploy. Then put the `flockstack.io` route back in `wrangler.jsonc`, or the next deploy drops it again.

### 3. Cut over the EU

After the US has held for a day: the same with `--env eu`, `https://eu.flockstack.io`, `flockstack-eu` and `flockstack-router-eu`, and remove the `routes` entry of `env.eu` in `wrangler.jsonc`.

### 4. Afterwards

The staged top-level router and `workers.dev` addresses can stay: they answer only for `workers.dev`. Delete a staging Worker with `npx wrangler delete --name <name>`.

### 5. Turn the API Worker on

The router sends `/api/v1`, `/mcp` and the OAuth endpoints to the API Worker only when it has the `API` binding **and** its secret `API_ENABLED` says so. Until then (a router deployed with the binding and no secret) everything is the app's, as before. Do it one group at a time, US first, EU a day later.

1. **Secrets.** For each region: `npx wrangler secret put <NAME> --config workers/api/wrangler.jsonc [--env eu]` for every name `node scripts/api-env.mjs` lists that the app has (the app's values; the API Worker cannot read the app's secrets). Check with `npx wrangler secret list --config workers/api/wrangler.jsonc [--env eu]`.
2. **Deploy.** `node scripts/deploy-all.mjs --only us` deploys the app, the API Worker, the public Worker and the router (the binding exists, `API_ENABLED` does not: nothing changes for visitors). Check: `curl -s -o /dev/null -w '%{http_code}\n' https://flockstack.io/api/v1/openapi.json` (200, PUBLIC) and `curl -sI https://flockstack.io/api/v1/contacts | grep -i x-served-by` (`app`).
3. **Stage it on workers.dev first.** The staged router and the domain's are one Worker (`flockstack-router`; for the EU `flockstack-router-eu`), so a request to its `workers.dev` address has a switch of its own: `echo all | npx wrangler secret put API_ENABLED_WORKERS_DEV --config workers/router/wrangler.jsonc` (EU: `--env eu-staged`). `API_ENABLED` is the domain's and stays unset. Try `R=https://flockstack-router.$SUB.workers.dev` (the API Worker's metadata names `APP_URL`, the real domain):
   - `curl -si $R/api/v1/contacts -H 'authorization: Bearer <test key>'` is 200 with `x-served-by: api`; the same without a key 401 with `www-authenticate`; `curl -si -X OPTIONS $R/api/v1/contacts -H 'origin: https://x.example' -H 'access-control-request-method: POST'` is 204 with the CORS headers;
   - `curl -si $R/.well-known/oauth-protected-resource`, `$R/.well-known/oauth-authorization-server` (the issuer and endpoints name `APP_URL`, the real domain);
   - an MCP client against `$R/mcp` with a test key: initialize, tools/list, a read tool, a write tool on a test newsletter;
   - `curl -s $R/api/v1/openapi.json | head -c 200` and `/api/v1/account/export.zip?token=bad` (401 in the API's error shape);
   - `npx wrangler tail flockstack-api --format json` shows `outcome: ok` and no `[revalidate]` warnings after a write that drops a page.
4. **Turn on one group on the domain**, the least risky first: `echo wellknown | npx wrangler secret put API_ENABLED --config workers/router/wrangler.jsonc`, check, then `wellknown,oauth`, then `wellknown,oauth,mcp`, then `all` (REST). Each `secret put` takes effect in seconds and needs no deploy; the router's logs (`npx wrangler tail flockstack-router`) show `[router] api ...` lines whenever the API Worker failed and the app answered. After each step check `x-served-by: api` and `server-timing: api;dur=...` on the group, a real MCP client connecting with OAuth (ChatGPT or Claude: discovery, consent in the app, token, a tool call), and the error rate of `flockstack-api` in the dashboard.
5. **EU:** the same with `--env eu` for the API Worker's secrets and `flockstack-router-eu` (`--env eu` for `API_ENABLED`, `--env eu-staged` for the trial).

**Rollback, in seconds.**

- One group or all: `npx wrangler secret delete API_ENABLED --config workers/router/wrangler.jsonc` (or `put` a shorter list; EU: add `--env eu`). `API_ENABLED_WORKERS_DEV` is the same switch for `workers.dev` addresses. Everything goes back to the app, which has every route and was never changed by this.
- The API Worker itself broke but the router still sends to it: `echo true | npx wrangler secret put API_DISABLED --config workers/api/wrangler.jsonc`. It then answers 503 with `x-fs-api-unprocessed`, which the router turns into the app's answer for every method (bodies up to 1 MiB are copied for that), without touching the router.
- A bad API Worker version: `npx wrangler rollback --config workers/api/wrangler.jsonc`.

What to watch: `server-timing` and `x-served-by` on API calls; 502s with `"code":"unavailable"` (the router could not get an answer for a write: the write may or may not have happened, so check it before retrying); `[router] api failed` lines; a difference between the two stacks' answers for the same call, which `FLOCKSTACK_API_TARGET=worker npm test` should have caught.

### 6. Turn the readers Worker on

Reader traffic reaches the readers Worker only when three things hold: the Worker is deployed and has its secrets, the router has the `READERS` binding and a group named in its secret `READERS_ENABLED`, and the newsletter's host reaches the router. Do it in this order, US first, EU a day later. Nothing here changes a link, a token or an answer.

1. **Secrets.** `bash scripts/set-reader-secrets.sh us` (then `eu`) after a first `node scripts/deploy-all.mjs --only us` (the Worker exists and receives nothing). It asks for `BETTER_AUTH_SECRET` and `SUPPRESSION_HASH_KEY` hidden and twice (their values cannot be read back from the app: they must be the region's own), then the SES, QStash and Upstash names with the region's non-secret defaults suggested. `node scripts/readers-env.mjs` says which endpoint needs which: **the pixel and the click need only `BETTER_AUTH_SECRET`**, unsubscribe adds `SUPPRESSION_HASH_KEY` and `APP_URL`, the beacons nothing, the signup form sends a confirmation email and needs SES (`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_AWS_ACCOUNT_ID`, `EMAIL_PROVIDER`, `SENDING_ENABLED`, `SHARED_DOMAIN`, `APP_URL`, and `QSTASH_*`, `UPSTASH_*`, `SEND_RATE_PER_SECOND`, `SES_SNS_TOPIC_ARN`, `ADMIN_EMAILS`, `EMAIL_FROM` when the app has them). Check with `npx wrangler secret list --config workers/readers/wrangler.jsonc [--env eu]`.
2. **Try it on workers.dev.** `echo all | npx wrangler secret put READERS_ENABLED_WORKERS_DEV --config workers/router/wrangler.jsonc` (EU: `--env eu-staged`). With a real link from a test email: `curl -si $R/o/<token>` is a GIF with `x-served-by: readers`, `curl -si $R/c/<token>` a 302, `curl -si -X POST -d 'List-Unsubscribe=One-Click' $R/api/unsubscribe?token=<token>` a 200, and the message shows its open and click in the dashboard. A link signed with another `BETTER_AUTH_SECRET` is the symptom of step 1 gone wrong (the click shows the "Continue" page).
3. **Turn on one group on the domain**, the least risky first: `echo beacons | npx wrangler secret put READERS_ENABLED --config workers/router/wrangler.jsonc`, then `beacons,tracking`, then `...,unsubscribe`, then `all` (the signup form, last: it sends email). Each `secret put` takes effect in seconds. `npx wrangler tail flockstack-router` shows `[router] readers ...` whenever the Worker failed and the app answered.
4. **Move the newsletters' hosts to the router** (without this, steps 1 to 3 only change what `flockstack.io` itself receives): `node scripts/route-archive-hosts.mjs --to router` lists the routes (the SaaS zone's `<host>/*` and the shared zone's `*.SHARED_DOMAIN/*`), `--apply` moves them, then `wrangler secret put FLOCKSTACK_WORKER_NAME` on each app with its router's name (`flockstack-router`, `flockstack-router-eu`). Check `curl -sI https://<a newsletter's host>/ | grep x-served-by` (`app`, through the router: `server-timing` has `router;dur=`) and a tracked link on that host (`readers`).

**Rollback, in seconds.** `npx wrangler secret delete READERS_ENABLED --config workers/router/wrangler.jsonc` (or `put` a shorter list; EU: `--env eu`) sends every reader request back to the app. `echo true | npx wrangler secret put READERS_DISABLED --config workers/readers/wrangler.jsonc` makes the readers Worker answer 503 `x-fs-readers-unprocessed`, which the router turns into the app's answer for every method. For the hosts: `node scripts/route-archive-hosts.mjs --to app --apply` and delete `FLOCKSTACK_WORKER_NAME` from the apps. A bad version: `npx wrangler rollback --config workers/readers/wrangler.jsonc`.

## Things that can go wrong, and what to look at

- **A page looks unstyled or does not respond to clicks for some seconds after a deploy.** The window between deploying the app and the public pages Worker (above). `deploy-all` runs them back to back.
- **A new public path.** Add it to `lib/public-routing.js` and to its source (`DOC_PAGES`, `LEGAL_PAGES`, the route that writes the file); `tests/public-routing.test.mjs` fails until both agree. Redeploy the public Worker and the router.
- **A change to a docs page** reaches visitors only when the public pages Worker is deployed (`deploy-all` does it), and the app Worker keeps serving the same page for anyone it reaches directly.
- **A new page one segment under `/` for the website** is a new entry in `lib/website-routing.js`, as before; the router imports that file, so it changes there once.
- **The analytics of the public pages stop.** `POSTHOG_KEY` is a secret of each public Worker, not inherited from the app.
- **A visitor sees the app's 404 for a marketing page.** WEBSITE failed and the router fell back (`[router] website ...` in `wrangler tail`).
- **A new API route or action.** An action is picked up by the REST API and MCP from the registry as before, but `lib/actions/manifest.js` (what the API Worker routes by) is generated: `node --import ./tests/setup/register.mjs scripts/build-action-manifest.mjs` after changing an action's name, method, path or permission or adding a file of actions (`lib/actions/groups.js`); `tests/action-manifest.test.mjs` fails until it does. A new route file under `app/api/v1`, `app/mcp` or `app/.well-known` needs an entry in `API_ROUTES` (`workers/api/handler.js`) and in `lib/api-routing.js`; `tests/api-routing.test.mjs` fails until both agree.
- **A tracked link shows the "Continue" page, or an open is not counted, only on the readers Worker.** Its `BETTER_AUTH_SECRET` is not the app's value. `npx wrangler secret put BETTER_AUTH_SECRET --config workers/readers/wrangler.jsonc` again, or `READERS_ENABLED` off meanwhile.
- **A new reader endpoint.** Add its path to `lib/reader-routing.js` and its route to `workers/readers/handler.js` (`tests/reader-routing.test.mjs` fails until the lists, the table and the app's files agree), classify what it reads in `scripts/readers-env.mjs`, and keep it pure: no `cookies()`, no React.
- **An API call is slower on the API Worker than it was.** Read `server-timing` (`api;dur=` is the handler, `api-wait;dur=` the router's wait: the difference is a cold start or queueing), then `docs/PERFORMANCE.md`.

The optional collaboration Worker coordinates one SQLite Durable Object per account/campaign, using an EU-jurisdiction namespace in the EU region. Its `AUTHORITY` service binding calls the API Worker's named `CollaborationAuthority` entrypoint for current session/team/draft checks and compare-and-set checkpoints. Optional `COLLABORATION_SOCKET` bindings on the router/app carry only the WebSocket path; `COLLABORATION_STORAGE` bindings on app/API call the named cleanup/notification entrypoint. No public HTTP endpoint accepts an internal identity reference. The normal bindings remain unchanged until opt-in release; bootstrap targets before adding service bindings. `scripts/deploy-all.mjs` adds those bindings (to a copy of each configuration, for that deploy only) and deploys the optional Workers only for a region listed in `FLOCKSTACK_OPTIONAL_WORKERS` or `optional-workers.json` (`scripts/optional-workers.mjs`, [the runbook](OPTIONAL-WORKERS-RUNBOOK.md)). See [editor collaboration](EDITOR-COLLABORATION.md).
