// Briefings (docs/BRIEFINGS-DESIGN.md): a newsletter's sources, schedule and style, from which the engine (lib/briefings/)
// writes a sourced issue. The rules are here so the models, the actions, the dashboard and the engine read them from one place.
export const AI_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "groq", "together", "deepinfra", "fireworks", "mistral", "deepseek", "cloudflare", "typesafe", "openai-compatible"];
// TypeSafe answers typed judgments, not text: it can score stories and check claims, never extract or write.
export const JUDGMENT_ONLY_PROVIDERS = ["typesafe"];
export const AI_KEY_STATUSES = ["unchecked", "ok", "rejected"];
export const MAX_AI_KEYS_PER_ACCOUNT = 10;

export const BRIEFING_STATUSES = ["active", "paused"];
export const BRIEFING_SOURCE_KINDS = ["feed", "page", "url"];
export const BRIEFING_REVIEW_MODES = ["draft", "send_if_checks_pass"];
export const BRIEFING_STEPS = ["triage", "extract", "write", "check"];
export const BRIEFING_STAGES = ["collect", "group", "triage", "extract", "write", "check", "deliver", "done"];
export const BRIEFING_RUN_STATUSES = ["running", "drafted", "sent", "no_news", "stopped_at_budget", "failed"];
export const CHECK_STATUSES = ["pass", "warning", "blocker"];

export const MAX_BRIEFINGS_PER_NEWSLETTER = 1;
export const MAX_SOURCES = 100;
export const MAX_AUDIENCE_LENGTH = 2_000;
export const MAX_STYLE_GUIDE_LENGTH = 8_000;
export const DEFAULT_MAX_STORIES = 6;
export const MAX_STORIES = 15;
export const DEFAULT_MIN_SCORE = 60;
export const DEFAULT_BUDGET_USD = 0.25;
export const MAX_BUDGET_USD = 20;
export const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "UTC" };

export const RUN_RETENTION_DAYS = 90;
export const SEEN_RETENTION_DAYS = 30;
