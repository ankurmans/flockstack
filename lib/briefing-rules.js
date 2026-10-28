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
// Why a run that could have sent was held as a draft instead: a thin or failed run never sends.
export const HOLD_REASONS = ["review_mode", "thin", "checks", "partial", "agent_approval"];
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
export const DEFAULT_DISCOVERY = { maxQueries: 16, resultsPerQuery: 10, maxCandidates: 300, shortlist: 40, followLinks: 5, discoveryBudgetUsd: 0 };
export const DISCOVERY_MAXIMUMS = { maxQueries: 40, resultsPerQuery: 25, maxCandidates: 600, shortlist: 80, followLinks: 10, discoveryBudgetUsd: 20 };
// Verdict links in the owner's email open a confirmation page; a link works once and for this long.
export const VERDICT_LINK_DAYS = 14;
export const DEFAULT_MIN_SCORE = 60;
export const DEFAULT_BUDGET_USD = 0.25;
export const MAX_BUDGET_USD = 20;
export const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "UTC" };

export const RUN_RETENTION_DAYS = 90;
export const SEEN_RETENTION_DAYS = 30;
export const USAGE_RETENTION_DAYS = 2;
