# Performance after the 2026-10-27 release: size and cold start

The app Worker's handler is 36.26 MB, against 29.19 MB two days earlier (`perf-budgets.json`: 36.50 MB budget), and the first request of an isolate to `/signin` took 1.5 to 2.7 s on the platform. This page says where the bytes are, what the sign-in and dashboard path load, and what to do about it, ranked by saving for effort. It recommends and implements nothing, and raises no budget.

## How this was measured

Nothing was deployed and nothing production was touched. The numbers come from the release build already in this checkout (`.open-next`, built at the release commit; the handler is 36,259,205 bytes, the figure `npm run perf:budget` prints), from a second build of the commit before the batches (`76e2594`, built in a scratch folder), and from the existing tools: `scripts/perf-budget.mjs`, `scripts/route-weights.mjs`, `scripts/page-closure.mjs`, the handler's esbuild metafile and the chunk source maps. `scripts/chunk-attribution.mjs` (new, read-only) reads the source maps and says which package or file each chunk byte came from: `node scripts/chunk-attribution.mjs --top 40`. Its sizes are output bytes, counted in each of Next.js's two layers; they cover 23.3 of the 29.5 MB of chunk bytes (the rest is module wrappers and glue with no source). Cold-start timing is local: `wrangler dev --local` on a copy of the built app with a scratch D1 and R2 (never a production binding), a fresh process per sample. The platform is about twice as slow as a laptop (`docs/PERFORMANCE.md`).

## Where the 36.26 MB sits

| Part | MB | Notes |
| --- | --- | --- |
| Chunks listed by some route (`R.c(...)` in the route entries) | 14.3 | Loaded when the first request of that route arrives. `scripts/route-weights.mjs`: dashboard 6.8 (3.2 only dashboard), public pages 7.0 (1.9), readers 5.4 (1.7), API 4.0 (1.1), jobs and webhooks 2.9 (1.0). |
| Chunks no route lists | 15.2 | Loaded by `import()`: the action files (`lib/actions/*`), services, schemas, SDKs. Both layers have their own copy. Evaluated only when used. |
| Next.js runtime and the manifests OpenNext inlines | 4.0 | `load-manifest.external.js` is 1.38 MB of it (every route's manifests), the app-page runtime 0.76, the OG-image renderer `@vercel/og` 0.55. |
| Route entry files | 1.35 | Dashboard 0.44, public site 0.36, readers 0.26, other 0.25, API 0.04. |
| Other `node_modules` outside the chunks | 1.26 | AWS S3 client and its parts 0.85, react-dom's server build 0.2. |

By source (output bytes, both layers added; `chunk-attribution`):

| Source | MB | Used on Cloud? |
| --- | --- | --- |
| Next.js compiled into chunks | 2.68 | yes |
| Better Auth, its OAuth provider, kysely, jose, passkeys, X.509 | 2.51 | yes |
| AWS SDK (SES, CloudFront, core) in chunks, and S3 outside them | 1.23 + 0.85 | SES yes; CloudFront and S3 no (images and exports are in R2) |
| Vercel Blob with undici and `@vercel/cli-config` | 1.02 | no (`IMAGES_STORAGE=r2`) |
| zod (every action's schema) | 0.92 | yes |
| mingo (the document layer's query engine) | 0.76 | yes, see R2 |
| Tiptap, ProseMirror, Yjs (the editor) | 0.58 | the two editor pages |
| Stripe | 0.46 | yes |
| `lib/reader-language-copy.js` (698 phrases, six languages) | 0.59 | reader pages |
| `lib/actions/*` | 1.75 | yes |
| `models/*` | 0.85 | yes |
| `lib/og-fonts.js` (Geist, base64) | 0.19 | share cards |
| The public site (`app/(site)`, `lib/docs`) | 0.49 | the public pages Worker serves these; the app keeps them as the fallback |

Each library the server uses is bundled twice, once for the server-component layer and once for the SSR layer: 16.9 MB of the 23.3 attributed are files present in both, and the smaller copy of each is 7.0 MB (4.1 of packages, 2.9 of the project). That is Next.js's build and cannot be configured away.

## Why it grew 7.1 MB in two days

Handler size at each batch, from the `measured` notes of `perf-budgets.json` (MB, and the change from the one before):

| Batch | Handler | Change |
| --- | --- | --- |
| Content calendar (2026-10-24) | 29.19 | |
| Brand fleet | 29.45 | +0.26 |
| Bootstrap, teams, replies, reader settings, Stripe import, Markdown, language catalogs | 30.59 | +1.13 |
| Reader languages and translation | 30.96 | +0.38 |
| Guest authors, previews, code blocks, perks, ranges, events | 31.39 | +0.43 |
| Mailing lists and metered reading | 31.73 | +0.34 |
| HTML snippets, audience blocks, link picker | 31.81 | +0.08 |
| Paid trial fees | 31.99 | +0.18 |
| Supporter badges, creator matches, short posts | 32.26 | +0.27 |
| AI images and the account assistant | 32.64 | +0.38 |
| Reader billing languages, Reply Rules, with the revenue, referral and signup batches before them | 33.52 | +0.88 |
| Group subscriptions | 34.19 | +0.68 |
| Direct sponsorships | 35.52 | +1.32 |
| Reader pause, save offers, feedback | 35.88 | +0.36 |
| Realtime editing and private discussion | 36.25 | +0.37 |
| Final | 36.26 | +0.01 |

**Before and after, attributed.** A build of `76e2594` (the commit before the batches, handler 29,238,195 bytes; built in a scratch folder with the same dependencies) against the release build, both read with `scripts/chunk-attribution.mjs` and the handler metafiles:

| Part | 76e2594 | Release | Change |
| --- | --- | --- | --- |
| Chunks, SSR layer | 12.34 | 15.42 | +3.08 |
| Chunks, server-component layer | 10.72 | 14.05 | +3.33 |
| Route entry files (194 routes, then 227) | 1.05 | 1.35 | +0.30 |
| Inlined manifests (`load-manifest.external.js`) | 1.07 | 1.38 | +0.31 |
| Next.js runtime, other `node_modules`, OpenNext glue | 4.06 | 4.06 | 0 |
| **Handler** | **29.24** | **36.26** | **+7.02** |

Ninety-one percent of the growth is chunks: the project's own code, compiled twice. No new framework or SDK came in: packages grew 0.32 MB (the collaboration client, Yjs with `@tiptap/y-tiptap` and `lib0`, 0.15; Next.js itself 0.16). Of the 4.06 MB of chunk growth that has a source:

| Project code | Before | After | Change |
| --- | --- | --- | --- |
| `lib/` apart from actions and the catalog | 3.09 | 4.61 | +1.52 |
| `lib/reader-language-copy.js` (new, six languages) | 0 | 0.60 | +0.60 |
| `lib/actions/` (registry 278 to 355 public actions, schemas) | 1.22 | 1.75 | +0.53 |
| `models/` (record definitions) | 0.41 | 0.85 | +0.45 |
| `app/` (27 more dashboard routes, 6 reader routes, server actions) | 0.87 | 1.21 | +0.34 |
| `components/` | 1.23 | 1.41 | +0.17 |
| Packages | 12.20 | 12.52 | +0.32 |

The other 2.4 MB of chunk growth has no source: module wrappers and glue that grow with the number of modules, 25 percent more routes in the lists of `route-weights.mjs` (dashboard 65 to 92, readers 50 to 56) and their manifests. The four files that grew most by themselves are the catalog (+0.59), `lib/feed-render.js` (+0.21 in the server-component layer; the file is 2 KB, so the maps are crediting it with modules merged into its factory, and what they are is worth a look with `--top`), `lib/actions/define-action.js` (+0.13, the shared action helper, which grows with the registry) and `app/archive/actions.js` (+0.10).

## What the sign-in and dashboard path loads

`/signin`, the first request after a cold start for most visitors, and the dashboard layout need little code. Static import closure (`scripts/page-closure.mjs`, what a request evaluates before it answers):

| Entry | Closure | New files since `76e2594` on it |
| --- | --- | --- |
| `app/signin/page.js` | 0.90 MB | `lib/sponsorship-blocks.js`, `lib/message-kinds.js` (both tiny) |
| `app/(app)/layout.js` | 1.19 MB (guard 1.35) | the same two, and `components/ShortcutAssistant.jsx` |
| overview | 1.33 MB | adds `lib/reader-language-copy.js` (0.21 MB), `lib/reader-languages.js`, `lib/reader-problem-copy.js`, `lib/audience-blocks.js`, `lib/html-snippets.js` |
| campaign list | 1.58 MB | the same |
| campaign editor | 2.85 MB | 20 new files: the cards for issue links, reader preview, author, short post, send time, and the same catalog |

So the layout and the sign-in page were not made heavier by the release: none of the release's features loads on them. Two things are on them that are not features: **mingo** (0.49 MB of the 0.90 MB, through `lib/docdb/model.js`, which imports it at the top for the few queries SQL cannot express) and **the document layer** (0.07 MB). The overview and the campaign list gained **the whole six-language reader catalog** (0.21 MB) through `lib/campaign-queries.js` to `lib/sending-rules.js` to `lib/confirmation-content.js` to `lib/reader-languages.js`; it is there for the confirmation email's default words, which only a send needs. The campaign editor gained the catalog and a handful of small cards. The collaboration client (Yjs, Tiptap collaboration) is on `/campaigns/<id>/collaborate` only.

Cold request, local, fresh process, current build (three samples each; `wrangler dev --local`):

| Request | Time |
| --- | --- |
| `/signin` as the first request | 0.49 to 0.51 s |
| `/api/health` as the first request | 0.40 to 0.43 s |
| `/signin` after that | 0.11 s |
| any second request | 0.02 s |

About 0.42 s is the isolate: reading and parsing the script and starting Next.js. The `/signin` route adds 0.11 s of first evaluation. So roughly four fifths of a cold sign-in is the size of the whole script and the framework's start, and one fifth is what the route loads. That is 11 to 12 ms per MB of script on this machine (including Next.js's start), and `docs/PERFORMANCE.md` measured 30 ms per MB on the platform; the savings below use that range. It also means that making a route's own closure smaller can win at most the fifth.

Reading the three together: the release added code, not weight on the first request. The isolate pays for the script's size (the 7.0 MB), the sign-in route pays only for its closure, and that closure did not change.

## Recommendations, by saving for effort

The savings are bytes of the handler and, where it changes what a cold request evaluates, the evaluated bytes. The milliseconds are bytes times 12 to 30 ms per MB; they are estimates and none was measured on the platform.

| # | What | Saves | Effort | Risk |
| --- | --- | --- | --- | --- |
| R1 | Leave the self-hosting providers out of the Cloud build | 2.2 MB of bytes (6 percent); about 25 to 65 ms cold | Low | Low |
| R2 | Keep mingo off the static path of every page | 0.5 MB less evaluated on sign-in and every dashboard page; up to 0.4 MB of bytes if its operators are narrowed; about 10 to 50 ms cold | Low to medium | Low |
| R3 | Take the reader catalog off the dashboard path | 0.21 MB less evaluated on the overview and the campaign list; about 3 to 6 ms | Trivial | None |
| R4 | Serve share cards from a Worker of their own | 0.75 MB of handler and 1.4 MB of attached WebAssembly; about 10 to 20 ms | Medium | Low |
| R5 | A Cloud app build without the public site and the API routes | 3.1 to 3.5 MB (9 to 10 percent); about 40 to 100 ms | High | Medium |
| R6 | Dashboard actions through the API Worker, not loaded in the app | 5 MB or more; about 60 to 150 ms | Very high | Medium |

**R1. Leave the self-hosting providers out of the Cloud build.** Cloud keeps images and exports in R2, so Vercel Blob (with `undici`, 0.81 MB, and `@vercel/cli-config`, 0.13), the CloudFront client (0.34) and the S3 client with its parts (0.85, copied into `node_modules` by Next.js because `@aws-sdk/client-s3` is on its default external list) are 2.2 MB the Cloud Worker cannot reach. `lib/image-storage.js` loads them by `import()` only when `IMAGES_STORAGE` or `EXPORT_STORAGE` says so. The build already redirects modules for Cloud (`turbopack.resolveAlias` for the site extensions in `next.config.mjs`); add aliases to a stub that throws "not available on FlockStack Cloud" for those packages when the build is the Cloud build (a variable `deploy-all` sets, so the open source build is untouched), and keep `@aws-sdk/client-sesv2`, which sends. Check: `scripts/perf-budget.mjs` shows about 34.1 MB; `tests/dashboard-weight.test.mjs` and the image-storage tests still pass; a Cloud config with `IMAGES_STORAGE=s3` fails at startup with the stub's message, which `validateImagesConfig` should say first. Verify `EXPORT_STORAGE` has no Cloud use of S3 before.

**R2. Keep mingo off the static path.** `lib/docdb/model.js` imports `Aggregator` and `Query` at the top, so every page that touches the database evaluates mingo (754 KB in two layers; the esbuild closure puts 0.49 MB of the 0.90 MB sign-in closure there). Its only users are the filter the SQL translation cannot express (`new MongoQuery(residual)`, two sites) and aggregation pipelines for updates and `$lookup` (three sites). Load it at those sites with `await import("mingo")`. In the dashboard query-budget suite no residual filter ran (0 calls of `Query.test`) and 27 pipelines ran, mostly in writes, so the common read path stays free of it. A page that does run one pays the evaluation then, as before. Further, `mingo` has subpath exports (`mingo/core`, `mingo/operators/...`): import the core and register only the operators the code uses to cut its bytes. Check: add `node_modules/mingo/` to `NEVER_ON_A_PAGE` in `tests/dashboard-weight.test.mjs` so it cannot come back; count `Query.test` and `Aggregator.run` during the page renders of the query-budget test before and after.

**R3. Take the reader catalog off the dashboard path.** `lib/confirmation-content.js` needs the default words of the confirmation email, which only sending uses. Import `lib/reader-languages.js` there with `import()` where it is used (or let `lib/sending-rules.js` not import the module), and the overview and the campaign list lose 0.21 MB of static closure. Splitting the catalog by language (six modules, `en` always, the rest by `import()`) cuts what a reader page evaluates from six languages to one; the bytes stay. Check: `scripts/page-closure.mjs --why "app/(app)/(overview)/page.js" reader-language-copy` prints nothing.

**R4. Serve share cards from a Worker of their own.** `app/archive/[slug]/og/route.js` and `app/(site)/opengraph-image.js` use `@vercel/og` (0.55 MB), Geist as base64 (0.19 MB) and two WebAssembly files (1.4 MB attached to the upload). Nothing else in the app uses them. A small Worker built like the readers Worker (same route modules, `scripts/build-readers-worker.mjs`'s shims) behind a router rule would carry them; the app keeps the route as the fallback only if it can afford the bytes, so choose between a fallback and the saving. Check: budget before and after; a card still renders in each region.

**R5. A Cloud app build without the public site and the API routes.** The router serves the docs and legal pages from the public Worker and REST, MCP and OAuth from the API Worker, but the app keeps all of those routes so that turning a router switch off is a complete rollback. They weigh 1.9 to 2.3 MB for the public site (the chunks only public routes load 1.87 MB, plus 0.36 MB of route entries) and about 1.2 MB for the API routes (1.12 MB of chunks only they load, 0.04 of entries) and a share of the 1.38 MB of inlined manifests. A second app Worker built without them, which the router uses for the dashboard and the readers while the full app stays deployed as the fallback, would be about 33 MB. `docs/PERFORMANCE.md` says getting below 18 MB means dropping routes; with today's composition it does not: 15 MB of the handler is code no route lists (actions, services, schemas, SDKs), which every dashboard request path still needs. Two deploys of the app, a second `wrangler.jsonc` entry per region, and a router rule: weigh that against the gain.

**R6. Dashboard actions through the API Worker.** The dashboard calls `runAction`, which loads each action's file in the app (1.75 MB of action code, 0.92 of zod, 0.46 of Stripe, the SES client, models). The API Worker already has all of it in 9.2 MB. If the dashboard's server actions called the API Worker over a service binding, the app could drop most of those chunks. Auth, sessions, redirects and revalidation cross that boundary; it is a design change, not a build option.

**What not to do.** Do not raise a budget: the app is 0.24 MB under 36.50 MB, but the budgets exist because size is cold start. Do not add a warm-up request: `docs/PERFORMANCE.md` measured that the visitor's next request lands on another machine. Do not expect `import()` to shrink the script: every dynamic import is a chunk of its own in each layer, so laziness saves evaluation, not bytes (R2 and R3 are about evaluation; R1, R4 and R5 are bytes).

## What was not measured

- Platform cold starts. No throwaway Worker was deployed. The local figures above are for orientation; a real comparison needs `docs/PERFORMANCE.md`, "Measuring a cold start", on a throwaway stack.
- The cost of each batch alone. The by-batch table is the handler size recorded at each step; the only attributed before and after is `76e2594` against the release.
- An authenticated dashboard cold start: the local run has no session and an empty database, so it measures the sign-in page, not the overview.
- Whether V8 pays the same per MB for code that is never called. The 12 to 30 ms per MB come from whole-script measurements.
