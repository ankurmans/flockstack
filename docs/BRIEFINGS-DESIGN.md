# Briefings: design note

Status: design, 2026-10-28. Nothing here is built yet; the build follows this note, and the note changes when the build shows it is wrong.

A briefing belongs to a newsletter. From a topic brief (no fixed source list), it searches the open web on a schedule, picks the stories its audience cares about, reads the original pages, writes a short sourced issue in the newsletter's style, checks the issue, and saves it as a draft (or, when the account allows, sends it once every check passes). Each account brings its own AI provider key, and optionally its own search provider key, so the cost is the account's; model spend is capped per briefing per run, and discovery runs on free indexes and free tiers.

## What it reuses

| Need | Existing code |
| - | - |
| Fetching a public URL with limits | `lib/feed-fetch.js` (1 MB, 8 s, 3 redirects each re-checked), `lib/feed-url.js`, `getPrivateHostProblem` in `lib/webhook-url.js`; Workers run with `global_fetch_strictly_public` |
| Parsing RSS, Atom and JSON Feed | `lib/feed-parse.js` |
| Encrypting a stored credential | `lib/credentials.js` (AES-256-GCM, `CREDENTIALS_ENCRYPTION_KEY`, AAD context per value), hidden fields with `select: false` |
| An idempotent story queue | content items with `externalId` (`lib/content-items.js`) |
| A draft issue with a retry key | `create_campaign` with `externalId`, called through `runAction` with its own `via` (as `lib/agent-bootstrap.js` does) |
| Checks shown before a send | `check_campaign` (`lib/ready-check.js`, `lib/ready-check-data.js`) |
| Agent send approval | `agentApproval` on the newsletter, `guardCall` in `lib/agent-guard.js` |
| Other languages for readers | reader translation (`readerTranslations`, `lib/reader-translation.js`; en, es, fr, de, it, pt) |
| Lean Worker builds without Next.js | `scripts/build-api-worker.mjs` with a different entry, as the readers Worker does |
| Optional Workers switched on per region | `scripts/optional-workers.mjs`, `FLOCKSTACK_OPTIONAL_WORKERS` |

## Data model

Seven collections and one migration (`0049_briefings.sql`, additive). All are account-scoped (`accountScoped` plugin), included in account export (keys as metadata only) and deleted by account purge.

**`AiProviderKey`** (account level, shared by the account's briefings; holds model keys and search keys)

- `name`, `provider` (one of the model or search providers below), `baseUrl` (only for `openai-compatible`; https, public host, default port), `accountRef` (only for `cloudflare`: the user's own Cloudflare account ID)
- `secret`: the encrypted key, `select: false`, context `ai-key:<accountId>:<keyId>`. Never returned by any action, never logged, never sent anywhere but the provider it was saved for.
- `hint`: the last four characters, for telling keys apart
- `status` (`unchecked`, `ok`, `rejected`), `checkedAt`, `lastUsedAt`, `createdBy`

**`Briefing`** (one per newsletter at launch)

- `newsletterId`, `name`, `status` (`active`, `paused`)
- `brief`: `{ topic, audience, useful, examples[] }`. `useful` says what makes a story worth a reader's time; `examples` (at most 10) are `{ url, note }`, stories the owner would have wanted, used for queries and as the ranker's first positives.
- `trustedOutlets[]` (hosts, at most 50): a ranking boost and a fallback index (their own feeds are read each run), never a limit on what is searched.
- `blockedHosts[]` (at most 100): hosts never fetched or cited for this briefing, whatever their `robots.txt` says (for example a publisher whose terms forbid automated collection).
- `discovery`: `{ searchKeyId, maxQueries (default 16, at most 40), resultsPerQuery (default 10, at most 25), maxCandidates (default 300, at most 600), shortlist (default 30, at most 60), followLinks (default 5 per strong article), discoveryBudgetUsd (default 0), lookbackHours (default 30, at most 168), mondayLookbackHours (default 72, at most 168) }`. A run reads news from lookbackHours before it starts (mondayLookbackHours on a Monday in the schedule's time zone, to cover the weekend), not from the last run: a manual run an hour after the scheduled one would otherwise see an hour of news. Items older than the window are dropped; the seen-URL dedupe and the stale-page check still apply, and among sources of one kind and trust the newest leads.
- `schedule`: `{ days: [1..7], time: "HH:MM", timeZone }`, and the derived `nextRunAt`
- `styleGuide` (plain text, at most 8,000 characters)
- `languages`: the issue is written in the first; the translate step writes the others (beta, labelled as such to readers)
- `stories`: `{ minFull, maxFull, briefItems }` (defaults 6, 10 and 10): between `minFull` and `maxFull` full stories (a paragraph or two each, as many as clear `minScore`), then up to `briefItems` one-line items with a link. `minScore` defaults to 60.
- `sections[]` (optional, at most 12): the issue as labelled sections in reading order (see "Sections" below)
- `steps`: `{ query, triage, extract, write, check, translate }`, each `{ keyId, model }`; `translate` is needed only when `languages` has more than one. The check step must use a different model from the write step; saving the same model is refused.
- `prices`: optional per-model `{ inputPerMillion, outputPerMillion }` in USD, overriding the built-in table
- `budgetUsd`: the model spend cap per run (default 0.25, at most 20), with optional per-step shares `stepBudgets: { query, triage, extract, write, check, translate }` (defaults 5, 10, 35, 20, 15, 15 percent). Discovery has its own `discoveryBudgetUsd`, 0 by default because the default indexes and free tiers cost nothing.
- `reviewMode`: `draft` or `send_if_checks_pass` (Phase 3; until then only `draft` is accepted)
- `testEmail`: the address the test send goes to, which must be a team member's address

**`BriefingRun`** (one per briefing per slot; the unique `(briefingId, slot)` index is the lock, as `SeriesRun` is for series)

- `slot` (the scheduled local date, or `manual:<timestamp>`), `stage` (`discover`, `group`, `triage`, `extract`, `write`, `check`, `deliver`, `done`), `status` (`running`, `drafted`, `sent`, `no_news`, `stopped_at_budget`, `failed`)
- `counts`: `{ queries, results, candidates, fresh, groups, shortlisted, picked }`, plus `discoveryNotes[]` (`{ provider, problem, scope }`: a limit hit, a refused robots path, a provider error)
- `stories[]`: `{ externalId, title, url, score, sources[] }`
- `calls[]`: `{ step, provider, model, inputTokens, outputTokens, costUsd, costFrom: "provider" | "price_table" }`, and `costUsd` (the total)
- `stories[]` also carry `kind` (`full` or `brief`) and `sourceKind` (`reporting`, `press_release`, `filing`, `regulator`, `company`, `community`, `other`).
- `thin`, `heldReason` (`review_mode`, `thin`, `checks`, `partial`, `agent_approval`), `languages[]` (`{ language, status }`)
- `checks[]`: `{ id, status, message }`, `campaignId`, `error`, `startedAt`, `finishedAt`
- Working data between stages (`items`, `records`, `draft`) is kept on the run while it is running and dropped when it finishes. Runs are kept 90 days.

**`BriefingSeen`** (dedupe across runs): `{ briefingId, urlHash, storyKey, firstSeenAt }`, unique on `(briefingId, urlHash)`, kept 30 days.

**`BriefingVerdict`** (the owner's keep or drop on a story): `{ briefingId, runId, storyKey, url, verdict: keep | drop, features, linkId, decidedBy, decidedAt }`, unique per story per run, and `linkId` unique so an email link counts once. The training data for the ranker. Kept while the briefing exists.

**`BriefingPublisher`** (what a briefing has learned about a host): `{ briefingId, host, seen, shortlisted, picked, kept, dropped, firstSeenAt }`, so new publishers earn a score over time.

**`DiscoveryUsage`** (pacing an account's search keys across its briefings): `{ provider, keyId, window: minute | hour | day, windowStart, count }`, kept 2 days.

## Actions

A new `Briefings` group in the registry, so the dashboard, REST and MCP get the same actions, schemas and tests (`tests/parity.test.mjs`, `tests/agent-scopes.test.mjs`).

| Action | REST | Scope class |
| - | - | - |
| `list_briefings` | `GET /briefings` | read |
| `get_briefing` | `GET /briefings/{id}` | read |
| `create_briefing` | `POST /briefings` | write (send with `send_if_checks_pass`) |
| `update_briefing` | `PATCH /briefings/{id}` | write (send when it turns on `send_if_checks_pass`) |
| `pause_briefing` | `POST /briefings/{id}/pause` | write |
| `resume_briefing` | `POST /briefings/{id}/resume` | write (send with `send_if_checks_pass`) |
| `delete_briefing` | `DELETE /briefings/{id}` | destructive |
| `run_briefing` | `POST /briefings/{id}/run` | write; 6 an hour |
| `list_briefing_runs` | `GET /briefings/{id}/runs` | read |
| `get_briefing_run` | `GET /briefing-runs/{id}` | read |
| `rate_briefing_story` | `POST /briefing-runs/{id}/stories/{storyKey}/verdict` | write-draft |
| `add_ai_key` | `POST /ai-keys` | admin |
| `list_ai_keys` | `GET /ai-keys` | read |
| `check_ai_key` | `POST /ai-keys/{id}/check` | admin |
| `delete_ai_key` | `DELETE /ai-keys/{id}` | destructive; refused while a briefing uses the key |

`add_ai_key` takes the key once and answers with its `hint` only. Its description recommends adding keys from the dashboard rather than through an agent, so the key does not pass through a model's context. `get_briefing` shows which key each step uses by name and hint, never the key.

`rate_briefing_story` records keep or drop. The dashboard's run page calls it directly. The owner's email carries a signed, single-use link per story and verdict (HMAC with `BETTER_AUTH_SECRET`, as other email links are; 14 days). The link opens a confirmation page that names the story and the verdict and has a POST button; a GET never records anything, so mail scanners and link previews cannot vote. These links are written as plain links, never through click tracking.

`run_briefing` queues a manual run for the engine's next tick. Without the briefings Worker (self-hosted, or the region has it off), it answers `unavailable`.

## Where the engine runs

The engine is plain JavaScript in `lib/briefings/` (collect, group, triage, extract, write, check, deliver, providers, prices). It runs in a new optional Worker, `flockstack-briefings` (`-eu` in the EU), built from `workers/briefings/index.js` with `scripts/build-api-worker.mjs` like the readers Worker. It is off unless `FLOCKSTACK_OPTIONAL_WORKERS` says `"briefings": true` for the region.

Why its own Worker: the app handler has about 250 KB left in its size budget, and the engine (fetching, HTML extraction, provider clients) has no reason to load on dashboard requests. Only the action file and the dashboard pages go into the app.

- **Bindings:** `DB` (the region's D1, the same database as the app), `AI` (Workers AI, for grouping embeddings only) and `API` (a service binding to the region's API Worker).
- **Trigger:** a Cron Trigger every 10 minutes. Each tick claims due briefings (`nextRunAt <= now`, a conditional update as `runDueSeries` does) and manual runs, and advances each run through as many stages as fit in about 5 minutes. Stage state is saved after every stage, so a run that is cut off resumes on the next tick. A run untouched for an hour is marked `failed`.
- **Delivery goes through the API Worker:** a new RPC entrypoint `BriefingsDelivery` on the API Worker (beside `CollaborationAuthority`) creates the content items, the draft campaign and the test email, through `runAction` with `via: "briefing"`. The briefings Worker therefore needs no SES or auth secrets, and the API Worker keeps doing every write that has a dashboard equivalent.
- **Secrets:** `CREDENTIALS_ENCRYPTION_KEY` on the app, the API Worker and the briefings Worker of each region, with the same value per region (the app and API encrypt when a key is added; the briefings Worker decrypts at run time). It is not set in production yet; it is set with a silent script, never typed into chat.
- **Self-hosted:** the same `lib/briefings` runs from the existing hourly cron route when `BRIEFINGS_IN_CRON=true`, so a self-hosted server does not need a second Worker.
- **Deploy:** `deploy-all` deploys the briefings Worker after the API Worker; it gets its own entry in `perf-budgets.json`. The test that pins the budget keys (`tests/perf-budget.test.mjs`) and the one that keeps optional Workers out of committed config (`tests/optional-workers.test.mjs`) are updated for it.

## The run

1. **Discover** (see "Open-web discovery" below): queries from the brief and from yesterday's winners, free indexes first, then the account's search provider, then one hop along the outbound links of strong articles. The result is a candidate list of `{ url, title, snippet, publishedAt, publisher, foundBy }`.
2. **Dedupe.** Canonicalise each URL (lower-case host, no fragment, no `utm_*`, `fbclid`, `gclid` or `ref`, AMP paths dropped, `rel=canonical` when a page is fetched) and drop what `BriefingSeen` already has or what is older than the previous run.
3. **Cluster.** Embed title plus snippet with `@cf/baai/bge-m3` (multilingual) on the Workers AI binding and put candidates above 0.86 cosine similarity in one story, so syndicated copies and the press release behind them become one story with several sources. Each source is labelled (`reporting`, `press_release`, `filing`, `regulator`, `company`, `community`). The story's primary source is independent reporting when the cluster has any, else the original document (a filing, a regulator notice, a press release). A story whose only source is a press release is labelled as such in the issue ("Announced by" or "Press release"). Without the binding, cluster by title-word overlap. This is FlockStack's only model call; it counts as one AI request against the account's daily allowance.
4. **Rank** (see "Ranking" below), and keep the `shortlist` best stories, then after triage the full stories (`minFull` to `maxFull`) and the brief items. None left means `no_news`: no draft, and the owner gets a one-line email.
5. **Extract.** For the survivors only, fetch the primary page (and at most one primary source it links to), reduce it to readable text (at most 20,000 characters), and ask the extract model for a record: what happened, who, numbers with the sentence each comes from, and the URL. Quotes are capped at 25 words. A paywalled page is never worked around: the story keeps only facts found on public pages, or is dropped.
6. **Write.** One call to the write model with the style guide, the brief and the records only (no raw pages): full stories first, then the brief items as one line each with their link. It returns Markdown in which every paragraph cites at least one record by number; code turns the citations into links to the originals.
7. **Check.** Code checks first: every number in the draft appears in the text of a page it cites; every link resolves (the link checker's rules); every story links to its original; no quote is over 25 words; length within bounds. Then the check model, which must differ from the writer, judges each claim against the record it cites (with a TypeSafe key: one Noul per claim, as in TypeSafe's citation check). Each check is recorded as `pass`, `warning` or `blocker`.
8. **Translate** (beta). When `languages` has more than one, the translate model writes each other language from the checked draft, within its share of the budget. The translations are stored against the draft for readers who choose that language, labelled beta; one that does not fit the budget is skipped and noted.
9. **Deliver.** Through `BriefingsDelivery`: the issue as a draft campaign (`externalId` `briefing:<briefingId>:<slot>`, so a retried run returns the same draft), one newsletter content item linked to it carrying every story's references (the calendar allows one newsletter item per issue, and per-story items would fill the 5,000-item cap within a year of daily runs; story keys stay on the run), a test email of the draft to `testEmail`, and a separate note to the owner with the run's checks, cost, discovery notes and a keep or drop link per story. The note is never part of the draft. With `send_if_checks_pass` (Phase 3), a run with no blocker and no warning is queued for sending, unless the newsletter has "ask me before an agent sends" on, which turns it into an approval request. A thin run, a run that stopped at the budget, a run with any blocker, and a run with a discovery provider that failed never send: they are held as a draft, with `heldReason` and the reason in the owner's email.

## Sections

A briefing can lay its issue out as a labelled skeleton instead of full stories then one-line items: `sections[]` on the briefing, at most 12, in reading order, each `{ id, title, purpose, format, maxItems, budgetShare, priority }`. `id` is a stable lower-case slug, `format` is `sentences` (a sentence or two per story, with its numbers) or `one-liners` (one sourced line per story), and `maxItems` is 1 to 25. `update_briefing` replaces the list; `[]` goes back to the unsectioned layout, where `stories` (`minFull`, `maxFull`, `briefItems`) decide the counts. A sections change is `write`, like any other setting.

- **Assignment.** After ranking, each shortlisted story is put in the section whose purpose it fits, or in none: with a TypeSafe key, one Choice per story over the sections' titles and purposes plus "none of these"; otherwise one JSON call to the triage model. A story with no section is not written. Each story's `sectionId` is kept on the run.
- **Caps.** A section keeps its best stories by score, up to its `maxItems`.
- **Budget shares.** `budgetShare` is a section's percent of the extract and write steps' shares of `budgetUsd`. The shares given add up to 100 at most; when none is given, the extract and write budget is split evenly between the sections. A section's extract and write calls carry its `sectionId`, and a call that would pass its share is not made.
- **Priority.** When the budget runs short, sections are written in `priority` order (1 first), else in reading order. A section that runs out of its share is `skipped_budget`; the others go on.
- **Empty sections.** A section that got no story is `empty` and left out of the issue: no heading without stories under it.
- **Rendering.** The issue is the sections in reading order, each under its title as a heading, its stories in its format; the write model writes each section's body and code adds the headings and turns citations into links. The draft body is the engine's Markdown, delivered unchanged.
- **Translation.** The translate step translates the whole checked draft, headings included, so a translated issue has the same sections.
- **On the run.** `run.sections[]` is `{ id, title, status (written, empty, skipped_budget, failed), items, costUsd, problem }`, shown in `get_briefing_run`, on the run's page and, with each section's cost and which were empty or skipped, in the owner's note.

## Open-web discovery

There is no source list. Cost is controlled by how wide each stage of the funnel is and by a spend cap per stage.

| Stage | Default width | What it costs |
| - | - | - |
| Queries | 16 | one call to the extract model (about 2,000 tokens) |
| Search results | 10 per query, 300 candidates after merging | free indexes and the search provider's free tier |
| Outbound links followed | 5 per article scoring in the top tenth, one hop, same-run only | free (own fetch) |
| Shortlist after ranking | 30 | Jev (input tokens only) and embeddings |
| Stories written | 6 to 10 full, about 10 brief | extract, write, check and translate calls |

**Queries.** One call to the extract model turns the brief, the examples and yesterday's kept stories (their companies, people, products and topics) into up to `maxQueries` search queries, each tagged with the angle it covers. Code adds one query per trusted outlet (`site:` where the provider supports it) and dedupes. Queries are stored on the run so the owner can see why a story was found.

**Indexes, in order.** Each is an adapter (below). A failing or limited index is noted and skipped; the run goes on with the rest.

1. Free indexes, no key: the GDELT DOC 2.0 API (free for commercial use; any use must cite the GDELT Project and link to gdeltproject.org, so the owner's run page credits it) (`api.gdeltproject.org/api/v2/doc/doc`, `mode=artlist`, `format=json`, up to 250 records, last three months), Hacker News through Algolia (`hn.algolia.com/api/v1/search_by_date`; the only published rule is 10,000 requests an hour per IP, and Workers share outbound IPs, so a run makes at most one request per query), and the feeds of trusted outlets and of publishers that earned a score (found by feed autodiscovery on their home page, read with the existing feed fetcher).
2. The account's search provider, with its own key (BYOK). Default adapter: TinyFish Search. Others can be added behind the same interface (another search API, or a model provider's own web search). No provider is required: without one, discovery uses the free indexes only.
3. Owner-only community signals: a generic `candidate-feed` adapter reads a JSON list of candidates from an https URL with a bearer key. Sniffington (Reddit and Bluesky) plugs in this way for the owner's own briefings; no Sniffington code is in this repository.

Google News search RSS is not used: `news.google.com/robots.txt` disallows `/rss/` for every user agent.

**Fetching.** Every fetch, the Worker's own and a provider's, is checked first against the briefing's `blockedHosts` and the host's `robots.txt` (cached 24 hours, for the user agent `FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)`, which names a page saying what the fetcher is, what it reads and how a site opts out). Before connecting, the hostname is resolved (DNS over HTTPS in Workers, `dns.lookup` on a self-hosted server) and every address must be public; the check runs again on each redirect hop. Pages are fetched by the Worker itself ( 1 MB, 8 s, re-checked redirects, at most 2 at a time per host, 300 fetches per run). The search provider's fetch (TinyFish Fetch) is used only for a page the Worker's own fetch cannot read as text, after the same `robots.txt` check, and counts against that provider's limits. Paywalls and blocks are never worked around: no cookies, no other user agents, no stealth or headless modes, no proxy rotation, no archive or cache copies. A page that answers 401, 403 or 429 to the honest fetcher is not retried another way. A public copy of a press release on another site (a wire service, the company's newsroom) may be cited instead; if no legitimate copy can be read, the story is dropped.

### The adapter interface

```js
// lib/briefings/discovery/<id>.js
export default {
	id: "tinyfish",               // gdelt, hn, outlet-feeds, tinyfish, candidate-feed, ...
	needsKey: true,               // false for the free indexes
	limits: { minute: 30, hour: 500 },          // published free-tier limits, for pacing; fetch: { minute: 150, day: 1000 }
	supports: { site: true, since: true, language: true, fetch: true },
	// Throws DiscoveryLimitError { scope: "minute" | "hour" | "day", retryAfterMs }, DiscoveryAuthError or DiscoveryError.
	async search({ query, since, language, max, signal }, ctx) {
		return { results: [{ url, title, snippet, publishedAt, publisher }], usage: { requests: 1, costUsd: 0 } };
	},
	async fetch({ url, signal }, ctx) {           // optional
		return { url, finalUrl, status, text, usage: { requests: 1, costUsd: 0 } };
	},
};
// ctx: { key (decrypted for this call only), fetchImpl, pace(scope), now }
```

The engine calls adapters through one function that paces them (`DiscoveryUsage` counters per account, provider and key, so two briefings on one key share its limits), applies the per-stage widths, records usage and cost, and turns errors into `discoveryNotes`. A key is decrypted for the call and passed only to its own adapter; adapters never log a request's headers or a key, and their errors are rewritten so a key cannot appear in a note.

### When a free-tier limit is hit

- **Per minute:** wait until the window resets if that fits in the run's time budget (at most 60 seconds), else carry the remaining queries to the next tick; the run resumes from saved state.
- **Per hour or per day:** stop using that provider for the rest of the window, note it on the run with the reset time, and continue with the other indexes. The engine never switches to a paid tier or another paid provider by itself.
- **Before the limit:** pacing keeps each key under its published limits, using the provider's own rate headers when it sends them, so a limit should be rare.
- **A thin run:** if the candidates after dedupe fall under twice `maxStories`, the run goes on with what it has, and the test email says the run was thin and why (which provider was limited).
- **A rejected key:** the key is marked `rejected`, the owner gets one email, and discovery continues without it.

### Ranking

Each story gets features: Jev scores against the brief (relevance to the topic, usefulness by the brief's own definition, novelty against the last 7 days of kept stories, primary-source likelihood); embedding similarity to the examples and to past kept stories, minus similarity to past dropped stories; the publisher's record (`BriefingPublisher`); a boost for trusted outlets; and how many independent publishers carried it. Until the briefing has 30 verdicts, the score is a fixed weighted sum. From 30 verdicts on, a small logistic model fitted in code on the owner's keep and drop verdicts sets the weights (refitted each run, no external training service), as Sniffington's ranker does. Trusted outlets and past winners only add to a score; they never filter a candidate out.

Without a TypeSafe key, the triage model scores the shortlist in one JSON call instead of Jev.

## Providers at launch (BYOK)

Model providers:

| Provider | API | Notes |
| - | - | - |
| OpenAI | Chat Completions | |
| Anthropic | Messages | |
| Google Gemini | OpenAI-compatible endpoint | |
| OpenRouter | OpenAI-compatible | reports the cost of each call, used as is |
| Groq, Together AI, DeepInfra, Fireworks, Mistral, DeepSeek | OpenAI-compatible | |
| Cloudflare Workers AI (the user's own account) | OpenAI-compatible endpoint, with the user's account ID and token | |
| TypeSafe (Jev) | `POST /v1/systemone` | triage and the claim check only; priced per input token |
| Any OpenAI-compatible server | OpenAI-compatible, `baseUrl` given by the user | https, public host only, same guard as feeds |

Search providers: TinyFish (the default for the owner's own briefings; for other accounts an option labelled "under your own TinyFish terms", and the default only after TinyFish confirms in writing) (Search and Fetch; free within published limits of 30 searches a minute and 500 an hour, and 150 fetches a minute and 1,000 a day, checked on its pricing page 2026-10-28) and `candidate-feed` (any https JSON list of candidates with a bearer key). TinyFish's terms license use for the key holder's internal business purposes and bar sublicensing, so the dashboard says a TinyFish key is used under the key holder's own TinyFish account and terms. Each further search API is added only after its pricing and terms are checked.

Two adapters cover the text providers (OpenAI-compatible and Anthropic Messages) plus one for TypeSafe. A user picks a model per step by its provider's name; FlockStack does not keep a model catalogue beyond the price table.

## Cost cap

- `budgetUsd` caps the model steps (queries, triage, extract, write, check); each step also has a share of it (`stepBudgets`), so a long extract cannot leave nothing for the check. `discoveryBudgetUsd` caps paid search separately and is 0 by default, which keeps discovery on free indexes and free tiers.
- Before each model call, the engine estimates its cost from the input size, the call's `max_tokens` and the model's price (the briefing's `prices`, else the built-in table, else refused: a model with no known price cannot run under a cap). If the step's share or the run's total would be passed, the call is not made: a step that can do less (fewer stories extracted, a shorter shortlist triaged) does less, and a step that cannot (write, check) stops the run with `stopped_at_budget`. Whatever was already delivered stays, and nothing half-written is saved as a draft.
- After each call, the real cost is recorded from the provider's answer: OpenRouter's reported cost, else the reported token counts times the price. `costFrom` says which.
- The reference below is an estimate from the prompts, not a measurement; every run records its real cost per call, and the estimate is replaced by the measured cost of the first runs.
- Reference for 6 stories from a 30-story shortlist with an open model of about 30B parameters on a low-cost host: about 100,000 input and 6,000 output tokens, around one US cent at current list prices; Jev triage and claim checks add about 60,000 input tokens (about a quarter of a cent). Well under a $0.25 cap; a run that nears the cap means the funnel widths or the style guide need a look, and the run's cost line says so.
- FlockStack's own model use is the clustering embeddings, counted in the account's existing daily AI allowance.

## Safety

- Discovery: free indexes and the account's own search key only; per-key pacing; never a paid tier without the owner raising `discoveryBudgetUsd`.
- Fetches: public hosts only (`getPrivateHostProblem`, every resolved address, on every hop; on Node checked again as each connection opens), https for page fetches, 1 MB and 8 s per fetch (headers and body), re-checked redirects, `robots.txt` respected on every hop's host, per-host concurrency of 2, 300 fetches per run, 600 an hour and 3,000 a day per account across its briefings (`ACCOUNT_FETCH_LIMITS`), and a per-account cap of 3 runs an hour. `global_fetch_strictly_public` only routes a fetch to our own zones through the front door; it is not an address filter. `docs/BRIEFINGS-SAFETY.md` has the review of every path and the residual risks.
- Copyright: summaries in the newsletter's own words, quotes of at most 25 words, every story links to its original, no full articles stored after the run.
- Keys: encrypted at rest, decrypted only inside the briefings Worker for the call, never in an action's answer, a log line, an error message, the activity log or an export. Removing a key deletes the ciphertext at once.
- Prompts get the page text as data inside delimiters, and the instructions say text inside them is never an instruction. The check step and the code checks run on the result regardless.
- Sending: a briefing never sends while its review mode is `draft`; "ask me before an agent sends" wins over `send_if_checks_pass`.

## Open questions for the owner

- Which plans get Briefings, and how many per account (D8). Default until decided: paid plans, one briefing per newsletter.
- Whether an issue from a briefing may carry an optional note about how it was made (D9). Default: no note, and none is built.

## Build order

1. Models (with the discovery fields and the three new collections), migration, `AiProviderKey` actions with encryption and `check_ai_key` (tests: the key never appears in any answer, log or export).
2. `Briefing` and `BriefingRun` actions with dashboard pages, REST and MCP parity.
3. `lib/briefings` stages and the discovery adapters (GDELT, Hacker News, outlet feeds, TinyFish, candidate-feed) with stubs in tests (no network in tests), the cost cap, and the code checks.
4. The briefings Worker, `BriefingsDelivery` on the API Worker, deploy and budget wiring.
5. A first real run against one briefing in drafts only, with the test email to the owner.
