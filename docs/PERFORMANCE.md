# Performance: what makes a request slow, how to measure it, what keeps it fast

FlockStack Cloud runs on Cloudflare Workers. A request is slow for one of four reasons, in this order of how often they were the cause:

1. **The Worker's script was not loaded.** A new isolate loads the whole script before it answers anything, and Cloudflare starts new isolates all the time at our traffic. The app's script was 40 MB (63 MB before the first speed work): a cold request cost 1.5 to 4 seconds of which almost none was the page. Loading costs roughly 30 ms per megabyte, and evaluating the modules of what the request uses comes on top.
2. **The code the request evaluates.** Module top levels run on the first request of a route: the 230 actions' zod schemas, Better Auth with its plugins and its signing code, the AWS clients. They run once per isolate, so they are a cold-start cost and nothing after.
3. **Round trips to the database.** Every call to D1 is a hop, and a dashboard page is a chain of them (`tests/query-budget.test.mjs` counts them). Rows read and bytes read matter too.
4. **Work the page does for nobody.** Reading every issue a newsletter ever sent, with its body, to show five.

The app Worker is split so that most requests never pay 1 and 2: the router and the public pages Worker start in milliseconds, and `/api/v1`, `/mcp` and the OAuth endpoints are served by the lean API Worker (`workers/api`, 7.7 MB). `docs/ARCHITECTURE-WORKERS.md` has the picture.

## Budgets

`perf-budgets.json` holds the sizes the scripts must stay under: the app's `handler.mjs` and the script Wrangler uploads, the API Worker, the router and the public pages Worker. `node scripts/perf-budget.mjs` (`npm run perf:budget`) prints them and exits 1 when one is over; `scripts/deploy-all.mjs` runs it after building and before anything is changed (`--require-app`); `tests/perf-budget.test.mjs` runs it on every `npm test` that has a build. A budget is raised only in a change that says why a Worker had to grow, and the change should say what it bought.

When a budget fails, find what grew: for the app, `.open-next/server-functions/default/handler.mjs.meta.json` (esbuild's metafile, inputs by chunk file) and `node scripts/dedupe-chunks.mjs` output in the build log (Turbopack writes the same chunk under several names; the build keeps one, `open-next.config.ts`); for the API Worker, `node scripts/build-api-worker.mjs --metafile` writes `workers/api/dist/index.js.meta.json`.

## Headers that tell where time went

Every response carries `server-timing` and `x-served-by`. Through the router: `router;dur=` is the whole time in the router, `app;dur=` or `api;dur=` is the Worker's own handler (from the request reaching its code, so without starting its isolate) and `app-wait;dur=` or `api-wait;dur=` is how long the router waited for the Worker. The gap between the wait and the handler is the isolate: a cold start, or queueing. `x-served-by` is `router`, `website`, `public`, `api` or `app`.

## Measuring a cold start

Browsers and `curl` from one laptop cannot tell a cold request from a warm one; the Worker has to say. The technique, which `docs`-less scripts in someone's scratch directory used for every number in this repository's speed reports:

1. **Stamp the isolate.** Wrap a copy of the Worker's script so that every response carries `x-isolate-id` (a random id made on the first request of the isolate), `x-isolate-n` (how many requests that isolate has answered) and `x-handler-ms`. `n=1` is a request that started its isolate: cold. The wrapper is a few lines around the default export (`const stamped = { ...worker, async fetch(request, env, ctx) { ... } }`); it is for a throwaway build only, never committed. A random id cannot be made in the global scope of a Worker, so it is made inside `fetch`.
2. **Deploy it as a throwaway Worker** named `flockstack-speed-*`, `workers_dev` only, no routes, crons or custom domains, bound to the same D1 (read-only use: GETs that do not write) with throwaway secrets, and delete it after (`npx wrangler delete --name <name>`). Never measure on `flockstack` or `flockstack-eu`. Better Auth's first use of a host inserts one row in the `oauthResource` collection (`/.well-known/oauth-protected-resource`), and `/api/auth/jwks` creates a signing key when there is none, **encrypted with the throwaway's secret**: do not request `/api/auth/jwks` against a database that belongs to anything real.
3. **Get cold requests on purpose.** Isolates idle out after minutes and the pool is shared, so waiting is slow. A redeploy (`wrangler deploy --var CHURN:<time>`) throws the isolates away: send a burst of requests (one per route, all at once) 2 seconds after it, then the same burst 4 seconds later for the warm ones. Repeat for a few rounds. Classify by `x-isolate-n`: `1` cold; an isolate and route seen before, warm; the rest are the first request of a route in a warm isolate, which still evaluates that route's modules.
4. **Time the requests the way a client does:** `curl -w '%{time_starttransfer} %{time_appconnect}'` and take the difference (first byte minus the TLS handshake), from the same machine at the same time for the Worker and for a Worker that returns "ok", which is the floor (60 to 120 ms here). Report medians of many.
5. **CPU and wall time of the invocation:** `npx wrangler tail <name> --format json` prints `cpuTime` and `wallTime` for each request. Join them to your requests by time: the cold ones are the ones with `x-isolate-n: 1`. The platform's CPU on a cold request is about twice a laptop's.
6. **Locally, with less noise:** `npx wrangler dev --local --config <config> --persist-to <dir outside the config's folder>` runs the same workerd; changing the script file reloads it (a new isolate), and the first request after the reload is a cold one. Do this with a database seeded by `tests/helpers` to measure authenticated routes. Local numbers are about half the platform's.

## The database

`tests/query-budget.test.mjs` renders the dashboard's busiest pages inside their layout, as a signed-in visit, and counts what they ask the driver (`setQueryObserver` in `lib/docdb/driver.js`: one event per call, with the statement, its parameters, how many statements, how many rows were read). The budgets are the round trips and rows of each page today with a little room, and the same test asks SQLite (`scripts/explain-queries.mjs`, on a database built from `migrations/` as D1's is) whether any statement a page ran reads a table whole. `tests/send-budget.test.mjs` does the same for starting a send and for a batch of messages (round trips per message, which must not grow with the list).

`FLOCKSTACK_SQL_LOG=/tmp/sql.jsonl npm test` writes every distinct statement the whole suite ran; `node scripts/explain-queries.mjs /tmp/sql.jsonl` reports which of them read a collection's table whole, on that migrated schema. A table that has a few rows for ever may be fine; one that grows with customers, readers or sends needs an index in a new migration (`CREATE INDEX IF NOT EXISTS`; D1 only has what the migrations made).

What the audit found and what changed is in the commit messages of `perf/speed-2`; the standing rules are:

- **Ask for the fields a page shows.** `select(...)`, `exists`, `distinct` and an aggregate that starts with a `$match` and a `$project` of plain fields have SQLite hand over just those fields (`lib/docdb/model.js`, `selectedColumns`). A campaign carries its HTML (up to 200 KB), so a list of 300 of them used to read tens of megabytes to draw a table.
- **Bound the window in the first `$match`.** `getEmailStats` read every issue the newsletter ever sent to keep the last 60 days of them.
- **Run independent reads together** (`Promise.all`), and ask for the same thing once per request (`React.cache` in `lib/auth.js`, `lib/selected-newsletter.js`).
- **Every update is a read and a write** in the document layer (an optimistic compare-and-set), so an update costs two round trips: a loop of updates per message is the send path's cost (about 10 round trips per message). A single-statement `UPDATE ... json_set(...)` for `$set` and `$inc` of plain paths would halve it; it was not done because the semantics of casting, timestamps and unique indexes live in the JavaScript path.

### D1 read replication

D1 can serve reads from replicas close to the visitor (the Sessions API, `env.DB.withSession(...)`). It was **not enabled**; this is what it would take and what it risks.

- **Where.** `lib/docdb/driver.js` `d1Driver` talks to the binding through `binding.prepare(...)` and `binding.batch(...)`; with replication on it would talk to a session (`session = binding.withSession(bookmark)`; `session.prepare(...)`, `session.batch(...)`). The session must be per request, while the driver is per isolate, so it needs request-scoped storage: an `AsyncLocalStorage` started in `worker-entry.mjs` (app) and `workers/api/index.js` (API), around the handler, holding the session. `lib/docdb/driver.js` `getDriver` is the only place that builds the driver.
- **Consistency.** A session gives sequential consistency: within it, reads see its earlier writes and never go back in time, provided each request passes along the bookmark of the last (`session.getBookmark()`). Between requests the bookmark has to travel with the visitor: a cookie for the dashboard (sign in writes a session row, and the next request is a read that must see it, or the visitor lands on the sign-in page again), a header for API clients (`x-d1-bookmark` in the response and the next request), which API clients and MCP clients do not know to send, so a `POST` followed by a `GET` from a script could miss its own write. That is a behavior change for API consumers, which is why the API Worker should stay on the primary (`withSession("first-primary")`) for anything that carries an API key or an OAuth token, and replicas would serve only requests with a bookmark cookie, public pages and archives.
- **Webhooks, QStash jobs, crons, sends** must read the primary: they read what they or another job just wrote, with no visitor to carry a bookmark.
- **What it would buy.** The US database's primary is in Western Europe (`served_by_region: WEUR` for `flockstack`, whatever the visitor's continent), so a US visitor's page pays an ocean for each of its 14 to 35 round trips; replicas would take the reads to the visitor's region. The EU database is jurisdiction-restricted to the EU, where the visitors and the primary are already close. It is the biggest remaining gain for US dashboards, and the part that needs care is the bookmark; the flag it would sit behind is `D1_READ_REPLICAS=true`.

## Results

See `SPEED2-REPORT.md` of the branch that introduced this document (measured 2026-10-21 against throwaway Workers) for the before and after of each class of request.
