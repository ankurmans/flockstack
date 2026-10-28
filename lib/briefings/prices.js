// What a model costs, in USD per million tokens, for the cost cap (docs/BRIEFINGS-DESIGN.md, Cost cap). These are the
// providers' list prices as published around PRICES_AS_OF for a few low-cost models each; they go stale, so a briefing's
// own `prices` win, and a model in neither cannot run: a call with no known price can't be held to a cap.
// OpenRouter reports what each call cost, and that figure is recorded instead of this estimate.
export const PRICES_AS_OF = "2026-10";

export const PRICE_TABLE = {
	openai: {
		"gpt-4o-mini": [0.15, 0.6],
		"gpt-4.1-mini": [0.4, 1.6],
		"gpt-4.1-nano": [0.1, 0.4],
		"gpt-5-mini": [0.25, 2],
		"gpt-5-nano": [0.05, 0.4],
	},
	anthropic: {
		"claude-haiku-4-5": [1, 5],
		"claude-3-5-haiku-latest": [0.8, 4],
	},
	gemini: {
		"gemini-2.5-flash": [0.3, 2.5],
		"gemini-2.5-flash-lite": [0.1, 0.4],
		"gemini-2.0-flash": [0.1, 0.4],
	},
	openrouter: {
		"qwen/qwen3-30b-a3b": [0.08, 0.28],
		"openai/gpt-oss-20b": [0.04, 0.16],
		"meta-llama/llama-3.3-70b-instruct": [0.13, 0.4],
		"google/gemini-2.5-flash-lite": [0.1, 0.4],
	},
	groq: {
		"llama-3.1-8b-instant": [0.05, 0.08],
		"llama-3.3-70b-versatile": [0.59, 0.79],
		"openai/gpt-oss-20b": [0.1, 0.5],
		"qwen/qwen3-32b": [0.29, 0.59],
	},
	together: {
		"meta-llama/Llama-3.3-70B-Instruct-Turbo": [0.88, 0.88],
		"Qwen/Qwen3-235B-A22B-Instruct-2507-tput": [0.2, 0.6],
		"openai/gpt-oss-20b": [0.05, 0.2],
	},
	deepinfra: {
		"Qwen/Qwen3-30B-A3B": [0.08, 0.29],
		"meta-llama/Llama-3.3-70B-Instruct-Turbo": [0.1, 0.32],
		"openai/gpt-oss-20b": [0.03, 0.14],
	},
	fireworks: {
		"accounts/fireworks/models/qwen3-30b-a3b": [0.15, 0.6],
		"accounts/fireworks/models/llama-v3p3-70b-instruct": [0.9, 0.9],
		"accounts/fireworks/models/gpt-oss-20b": [0.07, 0.3],
	},
	mistral: {
		"mistral-small-latest": [0.1, 0.3],
		"ministral-8b-latest": [0.1, 0.1],
		"mistral-medium-latest": [0.4, 2],
	},
	deepseek: {
		"deepseek-chat": [0.28, 0.42],
	},
	cloudflare: {
		"@cf/qwen/qwen3-30b-a3b-fp8": [0.051, 0.335],
		"@cf/openai/gpt-oss-20b": [0.2, 0.3],
		"@cf/meta/llama-3.1-8b-instruct-fast": [0.045, 0.384],
	},
	// Output tokens are free of charge on TypeSafe.
	typesafe: {
		"jev-latest": [0.042, 0],
	},
};

// { inputPerMillion, outputPerMillion, from: "briefing" | "table" } or null.
export function findPrice({ provider, model, prices = [] }) {
	const own = (prices ?? []).find((entry) => entry?.model === model && Number.isFinite(entry.inputPerMillion) && Number.isFinite(entry.outputPerMillion));
	if (own) return { inputPerMillion: own.inputPerMillion, outputPerMillion: own.outputPerMillion, from: "briefing" };
	const listed = PRICE_TABLE[provider]?.[model];
	return listed ? { inputPerMillion: listed[0], outputPerMillion: listed[1], from: "table" } : null;
}

export function costOf(price, inputTokens, outputTokens) {
	return ((inputTokens || 0) * price.inputPerMillion + (outputTokens || 0) * price.outputPerMillion) / 1_000_000;
}
