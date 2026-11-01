// Briefings (docs/BRIEFINGS-DESIGN.md): a newsletter's sources, schedule and style, from which the engine (lib/briefings/)
// writes a sourced issue. The rules are here so the models, the actions, the dashboard and the engine read them from one place.
export const AI_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "groq", "together", "deepinfra", "fireworks", "mistral", "deepseek", "cloudflare", "typesafe", "openai-compatible"];
// Search and fetch providers for discovery (lib/briefings/discovery/), on the account's own key. TinyFish is used under the key
// holder's own TinyFish account and terms; candidate-feed is any https JSON list of candidates with a bearer key.
export const SEARCH_PROVIDERS = ["tinyfish", "candidate-feed"];
// TypeSafe answers typed judgments, not text: it can score stories and check claims, never extract or write.
export const JUDGMENT_ONLY_PROVIDERS = ["typesafe"];
export const AI_KEY_STATUSES = ["unchecked", "ok", "rejected"];
export const MAX_AI_KEYS_PER_ACCOUNT = 10;

export const BRIEFING_STATUSES = ["active", "paused"];
export const BRIEFING_REVIEW_MODES = ["draft", "send_if_checks_pass"];
export const BRIEFING_STEPS = ["query", "triage", "extract", "write", "check", "translate"];
// Each step's share of budgetUsd, in percent, unless the briefing sets its own.
export const DEFAULT_STEP_BUDGETS = { query: 5, triage: 10, extract: 35, write: 20, check: 15, translate: 15 };
export const BRIEFING_STAGES = ["discover", "group", "triage", "extract", "write", "check", "deliver", "done"];
export const BRIEFING_RUN_STATUSES = ["running", "drafted", "sent", "no_news", "stopped_at_budget", "failed"];
// Why a run that could have sent was held as a draft instead: a thin or failed run never sends. review_mode: the briefing keeps
// drafts (its mode, the Free plan, or auto-send turned off while the run was going). checks: a code check, the different-model judge
// or the ready-to-send check found something. partial: a step or a translation did not finish. daily_cap: the briefing already
// sent its allowance today. agent_approval: the newsletter asks before an agent sends, so the send waits on the Approvals page.
export const HOLD_REASONS = ["review_mode", "thin", "checks", "partial", "agent_approval", "daily_cap"];
// Sending by itself (reviewMode send_if_checks_pass, docs/BRIEFINGS-DESIGN.md, Auto-send): issues a briefing may send in a UTC day,
// unless the owner sets another cap with set_briefing_auto_send, and the most that cap can be.
export const AUTO_SEND = { dailyCap: 1, maxDailyCap: 3 };
// The pause link in the note after an auto-send works this long.
export const PAUSE_LINK_DAYS = 14;
// How long delivery waits for the ready-to-send check's links and claim check before it holds an issue as a draft, and how often
// the engine asks again meanwhile.
export const READY_CHECK_WAIT_MS = 10 * 60_000;
export const READY_CHECK_POLL_MS = 4_000;
export const STORY_KINDS = ["full", "brief"];
export const SOURCE_KINDS = ["reporting", "press_release", "filing", "regulator", "company", "community", "other"];
export const VERDICTS = ["keep", "drop"];
export const CHECK_STATUSES = ["pass", "warning", "blocker"];

export const MAX_BRIEFINGS_PER_NEWSLETTER = 1;
export const MAX_TOPIC_LENGTH = 500;
export const MAX_AUDIENCE_LENGTH = 2_000;
export const MAX_USEFUL_LENGTH = 2_000;
export const MAX_EXAMPLES = 10;
export const MAX_TRUSTED_OUTLETS = 50;
export const MAX_BLOCKED_HOSTS = 100;
export const MAX_STYLE_GUIDE_LENGTH = 8_000;
// Full stories (a paragraph or two each) and one-line items with a link.
export const DEFAULT_STORIES = { minFull: 6, maxFull: 10, briefItems: 10 };
export const MAX_FULL_STORIES = 15;
export const MAX_BRIEF_ITEMS = 20;
// lookbackHours: how far back a run looks for news; mondayLookbackHours on a Monday in the schedule's time zone, so the weekend is
// covered. Items older than the window are dropped, whenever the last run was.
export const DEFAULT_DISCOVERY = { maxQueries: 16, resultsPerQuery: 10, maxCandidates: 300, shortlist: 40, followLinks: 5, discoveryBudgetUsd: 0, lookbackHours: 30, mondayLookbackHours: 72 };
export const DISCOVERY_MAXIMUMS = { maxQueries: 40, resultsPerQuery: 25, maxCandidates: 600, shortlist: 80, followLinks: 10, discoveryBudgetUsd: 20, lookbackHours: 168, mondayLookbackHours: 168 };
// Verdict links in the owner's email open a confirmation page; a link works once and for this long.
export const VERDICT_LINK_DAYS = 14;
export const DEFAULT_MIN_SCORE = 60;
export const DEFAULT_BUDGET_USD = 0.25;
export const MAX_BUDGET_USD = 20;
export const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "UTC" };

// Pages, robots.txt files and draft links the engine may fetch for one account, across all its briefings and runs, per clock hour
// and per UTC day (lib/briefings/discovery/pacing.js reserveFetches). One run takes 300 at most (FETCH_LIMITS.perRun), so an hour
// holds two full runs. Discovery providers' own APIs are paced on their published limits instead, and model calls on budgetUsd.
export const ACCOUNT_FETCH_LIMITS = { hour: 600, day: 3000 };

// Runs asked for with run_briefing, per briefing per local day (lib/briefing-runs.js).
export const MANUAL_RUNS_PER_DAY = 3;
// The Free plan's briefing (owner decision D8): one, as Free has one newsletter, drafts only (it never sends by itself), and weekly.
// days: run days a week its schedule may have. scheduledGapDays: a scheduled run waits this long after the last scheduled one, so a
// daily schedule kept from a paid plan runs weekly after a downgrade; a day short of a week, so a weekly slot that moves with
// daylight saving still runs. manualGapDays: a manual run waits this long after the last manual one.
export const FREE_BRIEFINGS = { days: 1, scheduledGapDays: 6, manualGapDays: 7 };
// A briefing's issue as labelled sections (docs/BRIEFINGS-DESIGN.md, Sections): each is a pass over the ranked stories with its
// own cap and share of the extract and write budget. `sentences` is a lead or full stories; `one-liners` is a bullet per item.
export const SECTION_FORMATS = ["sentences", "one-liners"];
export const SECTION_STATUSES = ["written", "empty", "skipped_budget", "failed"];
// One icon per section, from one set (lib/section-icons.js draws them); a section without one takes the key of its id, else generic.
export const SECTION_ICON_KEYS = ["lead", "market-pulse", "earnings", "roundup", "deal-flow", "regulation", "people", "launches", "coming-up", "generic"];
export const MAX_SECTIONS = 12;
export const MAX_SECTION_ITEMS = 25;
export const MAX_SECTION_TITLE_LENGTH = 60;
export const MAX_SECTION_PURPOSE_LENGTH = 400;
export const RUN_RETENTION_DAYS = 90;
export const SEEN_RETENTION_DAYS = 30;
export const USAGE_RETENTION_DAYS = 2;
