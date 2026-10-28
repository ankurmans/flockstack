# Briefings: design note

Status: design, 2026-10-28. Nothing here is built yet; the build follows this note, and the note changes when the build shows it is wrong.

A briefing belongs to a newsletter. It watches a list of sources on a schedule, picks the stories its audience cares about, reads the original pages, writes a short sourced issue in the newsletter's style, checks the issue, and saves it as a draft (or, when the account allows, sends it once every check passes). Each account brings its own AI provider key, so the model cost is the account's and is capped per briefing per run.

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

Three new collections and one migration (`0049_briefings.sql`, additive). All are account-scoped (`accountScoped` plugin), included in account export (keys as metadata only) and deleted by account purge.

**`AiProviderKey`** (account level, shared by the account's briefings)

- `name`, `provider` (one of the list below), `baseUrl` (only for `openai-compatible`; https, public host, default port), `accountRef` (only for `cloudflare`: the user's own Cloudflare account ID)
- `secret`: the encrypted key, `select: false`, context `ai-key:<accountId>:<keyId>`. Never returned by any action, never logged, never sent anywhere but the provider it was saved for.
- `hint`: the last four characters, for telling keys apart
- `status` (`unchecked`, `ok`, `rejected`), `checkedAt`, `lastUsedAt`, `createdBy`

**`Briefing`** (one per newsletter at launch)

- `newsletterId`, `name`, `status` (`active`, `paused`)
- `sources[]` (at most 100): `{ id, kind: "feed" | "page" | "url", url, label, weight }`. `feed` is RSS, Atom or JSON Feed; `page` is a listing page whose new links are the items; `url` is one page checked for change.
- `schedule`: `{ days: [1..7], time: "HH:MM", timeZone }`, and the derived `nextRunAt`
- `audience` and `styleGuide` (plain text, at most 2,000 and 8,000 characters)
- `languages`: the issue is written in the first; the others are offered to readers through reader translation, labelled beta
- `maxStories` (default 6, at most 15), `minScore` (default 60)
- `steps`: `{ triage, extract, write, check }`, each `{ keyId, model }`. The check step must use a different model from the write step; saving the same model is refused.
- `prices`: optional per-model `{ inputPerMillion, outputPerMillion }` in USD, overriding the built-in table
- `budgetUsd`: the spend cap per run (default 0.25, at most 20)
- `reviewMode`: `draft` or `send_if_checks_pass` (Phase 3; until then only `draft` is accepted)
- `testEmail`: the address the test send goes to, which must be a team member's address

**`BriefingRun`** (one per briefing per slot; the unique `(briefingId, slot)` index is the lock, as `SeriesRun` is for series)

- `slot` (the scheduled local date, or `manual:<timestamp>`), `stage` (`collect`, `group`, `triage`, `extract`, `write`, `check`, `deliver`, `done`), `status` (`running`, `drafted`, `sent`, `no_news`, `stopped_at_budget`, `failed`)
- `counts`: `{ sources, fetched, fresh, groups, picked }`, plus `sourceErrors[]` (`{ sourceId, problem }`)
- `stories[]`: `{ externalId, title, url, score, sources[] }`
- `calls[]`: `{ step, provider, model, inputTokens, outputTokens, costUsd, costFrom: "provider" | "price_table" }`, and `costUsd` (the total)
- `checks[]`: `{ id, status, message }`, `campaignId`, `error`, `startedAt`, `finishedAt`
- Working data between stages (`items`, `records`, `draft`) is kept on the run while it is running and dropped when it finishes. Runs are kept 90 days.

**`BriefingSeen`** (dedupe across runs): `{ briefingId, urlHash, storyKey, firstSeenAt }`, unique on `(briefingId, urlHash)`, kept 30 days.

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
| `add_ai_key` | `POST /ai-keys` | admin |
| `list_ai_keys` | `GET /ai-keys` | read |
| `check_ai_key` | `POST /ai-keys/{id}/check` | admin |
| `delete_ai_key` | `DELETE /ai-keys/{id}` | destructive; refused while a briefing uses the key |

`add_ai_key` takes the key once and answers with its `hint` only. Its description recommends adding keys from the dashboard rather than through an agent, so the key does not pass through a model's context. `get_briefing` shows which key each step uses by name and hint, never the key.

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

1. **Collect.** Fetch each source with the feed fetcher's limits. Before the first fetch of a host in a run, read its `robots.txt` (cached 24 hours, 100 KB) and skip disallowed paths for the `FlockStack` user agent. At most 2 requests at a time to one host and 300 fetches per run. A failing source is recorded in `sourceErrors` and the run goes on.
2. **Dedupe.** Canonicalise each URL (lower-case host, no fragment, no `utm_*`, `fbclid`, `gclid` or `ref`, AMP paths dropped) and drop what `BriefingSeen` already has or what is older than the previous run.
3. **Group.** Embed title plus first sentence with `@cf/baai/bge-m3` (multilingual) on the Workers AI binding, and put items whose cosine similarity is above 0.86 in one story. Without the binding, group by title-word overlap. This is the one model call on FlockStack's side; it counts as one AI request against the account's daily allowance.
4. **Triage.** Score each story for this audience. With a TypeSafe key, one Jev request scores every story at once (a Score question per story on the audience and the style guide). With another provider, one JSON call to the triage model. Keep stories at or above `minScore`, best first, up to `maxStories`. None left means `no_news`: no draft, and the owner gets a one-line email.
5. **Extract.** For each picked story, fetch the original page (and at most one primary source it links to, such as a filing or a press release), reduce it to readable text (at most 20,000 characters), and ask the extract model for a record: what happened, who, numbers with the sentence each comes from, and the URL. Quotes are capped at 25 words.
6. **Write.** One call to the write model with the style guide, the audience and the records only (no raw pages). It returns Markdown in which every paragraph cites at least one record by number; code turns the citations into links to the originals.
7. **Check.** Code checks first: every number in the draft appears in the text of a page it cites; every link resolves (the link checker's rules); every story links to its original; no quote is over 25 words; length within bounds. Then the check model, which must differ from the writer, judges each claim against the record it cites (with a TypeSafe key: one Noul per claim, as in TypeSafe's citation check). Each check is recorded as `pass`, `warning` or `blocker`.
8. **Deliver.** Through `BriefingsDelivery`: one content item per story (`externalId` `briefing:<briefingId>:<urlHash>`, with its references), the issue as a draft campaign (`externalId` `briefing:<briefingId>:<slot>`, so a retried run returns the same draft), the content items linked to it, and a test email to `testEmail` with the run's checks and cost at the top. With `send_if_checks_pass` (Phase 3), a run with no blocker and no warning is queued for sending, unless the newsletter has "ask me before an agent sends" on, which turns it into an approval request.

## Providers at launch (BYOK)

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

Two adapters cover the text providers (OpenAI-compatible and Anthropic Messages) plus one for TypeSafe. A user picks a model per step by its provider's name; FlockStack does not keep a model catalogue beyond the price table.

## Cost cap

- Before each model call, the engine estimates its cost from the input size, the call's `max_tokens` and the model's price (the briefing's `prices`, else the built-in table, else refused: a model with no known price cannot run under a cap). If the run's cost so far plus the estimate is over `budgetUsd`, the call is not made and the run stops with `stopped_at_budget`; whatever was already delivered stays, and nothing half-written is saved as a draft.
- After each call, the real cost is recorded from the provider's answer: OpenRouter's reported cost, else the reported token counts times the price. `costFrom` says which.
- Reference for a run of 6 stories with an open model of about 30B parameters on a low-cost host: about 90,000 input and 5,000 output tokens, well under one US cent at current list prices; Jev triage and checks add about 40,000 input tokens. A run that costs more than the cap is a sign the style guide, the sources or `maxStories` need a look, and the run's cost line says so.
- FlockStack's own model use is the grouping embeddings, counted in the account's existing daily AI allowance.

## Safety

- Fetches: public hosts only (`getPrivateHostProblem`, `global_fetch_strictly_public`), https for page fetches, 1 MB and 8 s per fetch, re-checked redirects, `robots.txt` respected, per-host concurrency of 2, 300 fetches per run, and a per-account cap of 3 runs an hour across its briefings.
- Copyright: summaries in the newsletter's own words, quotes of at most 25 words, every story links to its original, no full articles stored after the run.
- Keys: encrypted at rest, decrypted only inside the briefings Worker for the call, never in an action's answer, a log line, an error message, the activity log or an export. Removing a key deletes the ciphertext at once.
- Prompts get the page text as data inside delimiters, and the instructions say text inside them is never an instruction. The check step and the code checks run on the result regardless.
- Sending: a briefing never sends while its review mode is `draft`; "ask me before an agent sends" wins over `send_if_checks_pass`.

## Open questions for the owner

- Which plans get Briefings, and how many per account (D8). Default until decided: paid plans, one briefing per newsletter.
- Whether an issue from a briefing may carry an optional note about how it was made (D9). Default: no note, and none is built.

## Build order

1. Models, migration, `AiProviderKey` actions with encryption and `check_ai_key` (tests: the key never appears in any answer, log or export).
2. `Briefing` and `BriefingRun` actions with dashboard pages, REST and MCP parity.
3. `lib/briefings` stages with provider stubs in tests (no network in tests), the cost cap, and the code checks.
4. The briefings Worker, `BriefingsDelivery` on the API Worker, deploy and budget wiring.
5. A first real run against one briefing in drafts only, with the test email to the owner.
