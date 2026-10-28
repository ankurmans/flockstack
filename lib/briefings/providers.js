import { getFeedUrlProblem } from "../feed-url.js";
import { estimateTokens } from "./meter.js";

// The model calls of a briefing, with the account's own key (docs/BRIEFINGS-DESIGN.md, Providers at launch). Three adapters:
// OpenAI-compatible Chat Completions (every text provider but Anthropic), Anthropic Messages (only because a user may bring
// their own Anthropic key: FlockStack itself never calls Anthropic) and TypeSafe's System One. Each call is held to the
// run's cost cap, timed out, retried once when the provider is busy, and its usage read from the answer.
// A key is only ever put in the request's header for the provider it was saved for, and never into an error or a log line.
export const CALL_LIMITS = { timeoutMs: 60_000, retries: 1, retryWaitMs: 1000, maxRetryWaitMs: 10_000 };
export const ANTHROPIC_VERSION = "2023-06-01";

export class ProviderError extends Error {
	constructor(message, { status, provider } = {}) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.provider = provider;
	}
}

function secretOf(key) {
	return String(key?.secret ?? key?.apiKey ?? "");
}

// Anything that could be a key, out of text that came back from a provider or a fetch library.
export function scrubSecret(text, secret) {
	let clean = String(text ?? "");
	if (secret && secret.length >= 4) clean = clean.split(secret).join("[key]");
	return clean
		.replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [key]")
		.replace(/\b(?:sk|pk|rk|gsk|xai|ts|key|tok)[-_][\w-]{8,}/gi, "[key]")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[key]")
		.slice(0, 300);
}

// The base address of a key's provider: the one lib/ai-keys.js resolved for the key (getAiKeyForRun), else the shared table
// with the user's Cloudflare account ID filled in. An OpenAI-compatible server's own address is checked like a feed's.
export function resolveBaseUrl(key, endpoints) {
	if (key.provider === "openai-compatible") {
		const problem = getFeedUrlProblem(key.baseUrl);
		if (problem) throw new ProviderError(`The key's server address can't be used: ${problem}`, { provider: key.provider });
		return String(key.baseUrl).trim().replace(/\/+$/, "");
	}
	const entry = endpoints?.[key.provider];
	const base = key.baseUrl || (typeof entry === "string" ? entry : (entry?.baseUrl ?? entry?.url));
	if (!base) throw new ProviderError(`No address is known for ${key.provider}`, { provider: key.provider });
	const filled = String(base).replace("{accountRef}", String(key.accountRef ?? ""));
	if (key.provider === "cloudflare" && !/\/accounts\/[a-f0-9]{32}\//i.test(filled)) throw new ProviderError("The Cloudflare key needs its account ID", { provider: key.provider });
	return filled.replace(/\/+$/, "");
}

function withVersion(base, path) {
	return /\/v\d+(?:beta)?$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryWait(response) {
	const header = Number(response.headers.get("retry-after"));
	return Number.isFinite(header) && header >= 0 ? Math.min(header * 1000, CALL_LIMITS.maxRetryWaitMs) : CALL_LIMITS.retryWaitMs;
}

async function errorDetail(response) {
	try {
		const text = await response.text();
		try {
			const body = JSON.parse(text);
			const message = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail;
			return typeof message === "string" ? message : JSON.stringify(message ?? "").slice(0, 200);
		} catch {
			return text.slice(0, 200);
		}
	} catch {
		return "";
	}
}

// POSTs a JSON body and answers the parsed JSON. Retries once on 429, 5xx and Anthropic's 529.
async function postJson({ url, headers, body, provider, secret, fetchImpl }) {
	for (let attempt = 0; ; attempt += 1) {
		let response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(CALL_LIMITS.timeoutMs),
			});
		} catch (error) {
			const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
			if (attempt < CALL_LIMITS.retries && !timedOut) {
				await sleep(CALL_LIMITS.retryWaitMs);
				continue;
			}
			throw new ProviderError(timedOut ? `${provider} took more than ${CALL_LIMITS.timeoutMs / 1000} seconds to answer` : `${provider} could not be reached`, { provider });
		}
		if (response.ok) {
			try {
				return await response.json();
			} catch {
				throw new ProviderError(`${provider} answered something that isn't JSON`, { provider, status: response.status });
			}
		}
		const busy = response.status === 429 || response.status >= 500;
		if (busy && attempt < CALL_LIMITS.retries) {
			await response.body?.cancel();
			await sleep(retryWait(response));
			continue;
		}
		const detail = scrubSecret(await errorDetail(response), secret);
		throw new ProviderError(`${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`, { provider, status: response.status });
	}
}

function numberOr(value) {
	return Number.isFinite(value) ? value : undefined;
}

// The answer's text and usage, from an OpenAI-compatible server. OpenRouter is asked for its own cost of the call.
async function chatCompletions({ key, model, system, user, json, maxTokens, temperature, fetchImpl, endpoints }) {
	const secret = secretOf(key);
	const base = resolveBaseUrl(key, endpoints);
	const body = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		max_tokens: maxTokens,
		temperature,
		...(json && { response_format: { type: "json_object" } }),
		...(key.provider === "openrouter" && { usage: { include: true } }),
	};
	const answer = await postJson({ url: `${base}/chat/completions`, headers: { authorization: `Bearer ${secret}` }, body, provider: key.provider, secret, fetchImpl });
	const text = answer?.choices?.[0]?.message?.content ?? answer?.choices?.[0]?.text ?? "";
	const usage = answer?.usage ?? {};
	return {
		text: typeof text === "string" ? text : "",
		usage: { inputTokens: numberOr(usage.prompt_tokens ?? usage.input_tokens), outputTokens: numberOr(usage.completion_tokens ?? usage.output_tokens), costUsd: key.provider === "openrouter" ? numberOr(usage.cost) : undefined },
	};
}

async function anthropicMessages({ key, model, system, user, maxTokens, temperature, fetchImpl, endpoints }) {
	const secret = secretOf(key);
	const base = resolveBaseUrl(key, endpoints);
	const body = { model, system, messages: [{ role: "user", content: user }], max_tokens: maxTokens, temperature };
	const answer = await postJson({
		url: withVersion(base, "/messages"),
		headers: { "x-api-key": secret, "anthropic-version": ANTHROPIC_VERSION },
		body,
		provider: key.provider,
		secret,
		fetchImpl,
	});
	const text = (answer?.content ?? [])
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("");
	return { text, usage: { inputTokens: numberOr(answer?.usage?.input_tokens), outputTokens: numberOr(answer?.usage?.output_tokens) } };
}

// The first JSON object in a model's answer: some wrap it in a code fence or a sentence, and a thinking block may come first.
export function parseJsonAnswer(text) {
	const clean = String(text ?? "")
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/```(?:json)?/gi, "")
		.trim();
	try {
		return JSON.parse(clean);
	} catch {
		const start = clean.indexOf("{");
		const end = clean.lastIndexOf("}");
		if (start === -1 || end <= start) return null;
		try {
			return JSON.parse(clean.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

// A text model's answer for one step: { text, json? }. meter admits it first and records its cost after.
export async function callModel({ key, model, step, system, user, json = false, maxTokens = 1000, temperature = 0.2, fetchImpl = globalThis.fetch, meter, endpoints }) {
	if (key.provider === "typesafe") throw new ProviderError("TypeSafe can score and check, not write: pick another key for this step", { provider: key.provider });
	resolveBaseUrl(key, endpoints);
	const inputChars = system.length + user.length;
	meter.admit({ step, provider: key.provider, model, inputChars, maxTokens });
	const run = key.provider === "anthropic" ? anthropicMessages : chatCompletions;
	let result;
	try {
		result = await run({ key, model, system, user, json, maxTokens, temperature, fetchImpl, endpoints });
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(`${key.provider} failed: ${scrubSecret(error?.message, secretOf(key))}`, { provider: key.provider });
	}
	const call = meter.record({ step, provider: key.provider, model, usage: result.usage, inputChars });
	return { text: result.text, json: json ? parseJsonAnswer(result.text) : undefined, call };
}

// One System One request: { answers, call }. Output tokens are free, so the estimate is the input alone.
export async function callTypeSafe({ key, model, step, state, questions, fetchImpl = globalThis.fetch, meter, endpoints }) {
	const secret = secretOf(key);
	const body = { model, state, questions };
	const inputChars = JSON.stringify(body).length;
	const base = resolveBaseUrl(key, endpoints);
	meter.admit({ step, provider: "typesafe", model, inputChars, maxTokens: 0 });
	let answer;
	try {
		answer = await postJson({ url: withVersion(base, "/systemone"), headers: { authorization: `Bearer ${secret}` }, body, provider: "typesafe", secret, fetchImpl });
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(`typesafe failed: ${scrubSecret(error?.message, secret)}`, { provider: "typesafe" });
	}
	const usage = { inputTokens: numberOr(answer?.usage?.input_tokens) ?? estimateTokens(inputChars), outputTokens: numberOr(answer?.usage?.output_tokens) ?? 0 };
	const call = meter.record({ step, provider: "typesafe", model, usage, inputChars });
	return { answers: answer?.answers ?? {}, call };
}
