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
	constructor(message, { status, provider, code } = {}) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.provider = provider;
		this.code = code;
	}
}

// A JSON-mode request the server turned down because what the model generated wasn't valid JSON (Groq's json_validate_failed;
// other OpenAI-compatible servers word it their own way). Asking again without JSON mode and parsing the answer usually works.
export function isJsonValidationFailure(error) {
	return error instanceof ProviderError && error.status === 400 && (error.code === "json_validate_failed" || /validate JSON|json_validate|invalid JSON|failed_generation/i.test(error.message));
}

export function isAuthFailure(error) {
	return error instanceof ProviderError && (error.status === 401 || error.status === 403);
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

// At most a short line of a provider's error body: plain text, no markup or control characters, the key scrubbed. A server the
// user pointed at could put anything there, and the line ends up in the run's error.
export const ERROR_DETAIL_CHARS = 100;

export function errorLine(text, secret) {
	const plain = String(text ?? "")
		.replace(/<[^>]*>?/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return scrubSecret(plain, secret).slice(0, ERROR_DETAIL_CHARS);
}

// { line, code }: the error's short line and the provider's own error code, when it gives one.
async function errorDetail(response, secret) {
	let text = "";
	try {
		text = (await response.text()).slice(0, 4000);
	} catch {
		return { line: "", code: null };
	}
	try {
		const body = JSON.parse(text);
		const message = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail;
		const code = typeof body?.error?.code === "string" ? body.error.code.slice(0, 60) : null;
		return { line: errorLine(typeof message === "string" ? message : JSON.stringify(message ?? ""), secret), code };
	} catch {
		return { line: errorLine(text, secret), code: null };
	}
}

// POSTs a JSON body and answers the parsed JSON. Retries once on 429, 5xx and Anthropic's 529. guard(url) checks the address
// first (the run fetcher's public-address check: an OpenAI-compatible server is any address a user typed); a model API never
// redirects, so a 3xx is an error and is not followed.
async function postJson({ url, headers, body, provider, secret, fetchImpl, guard }) {
	for (let attempt = 0; ; attempt += 1) {
		if (guard) {
			try {
				await guard(new URL(url));
			} catch (error) {
				throw new ProviderError(`${provider}'s address can't be used: ${errorLine(error?.message, secret)}`, { provider });
			}
		}
		let response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
				redirect: "manual",
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
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new ProviderError(`${provider} answered ${response.status}: a model API doesn't redirect, so FlockStack didn't follow it`, { provider, status: response.status });
		}
		if (response.ok) {
			try {
				return await response.json();
			} catch {
				throw new ProviderError(`${provider} answered something that isn't JSON`, { provider, status: response.status });
			}
		}
		const busy = response.status === 429 || response.status >= 500;
		// A wait longer than a short pause is the caller's to schedule (a sectioned run saves and goes on at the next tick).
		const askedWait = Number(response.headers.get("retry-after"));
		const shortWait = !Number.isFinite(askedWait) || askedWait * 1000 <= CALL_LIMITS.maxRetryWaitMs;
		if (busy && attempt < CALL_LIMITS.retries && shortWait) {
			await response.body?.cancel();
			await sleep(retryWait(response));
			continue;
		}
		const { line, code } = await errorDetail(response, secret);
		const error = new ProviderError(`${provider} answered ${response.status}${line ? `: ${line}` : ""}`, { provider, status: response.status, code });
		// How long the provider asked us to wait, for a caller that can come back later (a per-minute token limit on Groq).
		const retryAfter = Number(response.headers.get("retry-after"));
		if (response.status === 429 && Number.isFinite(retryAfter)) error.retryAfterMs = retryAfter * 1000;
		throw error;
	}
}

function numberOr(value) {
	return Number.isFinite(value) ? value : undefined;
}

// The answer's text and usage, from an OpenAI-compatible server. OpenRouter is asked for its own cost of the call.
// OpenAI's reasoning models (o1, o3, o4-mini, gpt-5 and its sizes) refuse max_tokens and any temperature: they take
// max_completion_tokens, which their reasoning counts against, so they are asked to reason as little as they can.
export function reasoningEffort(provider, model) {
	if (provider !== "openai" && provider !== "openrouter") return null;
	const name = String(model).replace(/^openai\//, "");
	if (/^gpt-5/.test(name)) return "minimal";
	if (/^o\d/.test(name)) return "low";
	return null;
}

// The open gpt-oss models reason before they answer, at medium effort unless told otherwise, and on every host the reasoning
// counts against max_tokens: at the small caps of extract and write it used the whole budget, so the answer came back cut off
// or empty. They take max_tokens and a temperature like any chat model, and are asked to reason little.
function isOpenWeightReasoner(model) {
	return /(^|\/)gpt-oss-/i.test(String(model));
}

function limitOptions(provider, model, maxTokens, temperature) {
	const effort = reasoningEffort(provider, model);
	if (effort) return { max_completion_tokens: maxTokens, reasoning_effort: effort };
	if (isOpenWeightReasoner(model)) return { max_tokens: maxTokens, temperature, reasoning_effort: "low" };
	return { max_tokens: maxTokens, temperature };
}

async function chatCompletions({ key, model, system, user, json, maxTokens, temperature, fetchImpl, endpoints, guard }) {
	const secret = secretOf(key);
	const base = resolveBaseUrl(key, endpoints);
	const body = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		...limitOptions(key.provider, model, maxTokens, temperature),
		...(json && { response_format: { type: "json_object" } }),
		...(key.provider === "openrouter" && { usage: { include: true } }),
	};
	const answer = await postJson({ url: `${base}/chat/completions`, headers: { authorization: `Bearer ${secret}` }, body, provider: key.provider, secret, fetchImpl, guard });
	const text = answer?.choices?.[0]?.message?.content ?? answer?.choices?.[0]?.text ?? "";
	const finishReason = answer?.choices?.[0]?.finish_reason ?? null;
	// OpenAI-compatible servers write prompt_tokens and completion_tokens; some write the Responses API's names, and Groq repeats
	// its usage under x_groq.
	const usage = answer?.usage ?? answer?.x_groq?.usage ?? {};
	return {
		text: typeof text === "string" ? text : "",
		finishReason,
		usage: { inputTokens: numberOr(usage.prompt_tokens ?? usage.input_tokens), outputTokens: numberOr(usage.completion_tokens ?? usage.output_tokens), costUsd: key.provider === "openrouter" ? numberOr(usage.cost) : undefined },
	};
}

async function anthropicMessages({ key, model, system, user, maxTokens, temperature, fetchImpl, endpoints, guard }) {
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
		guard,
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
// guard(url): the run fetcher's check that an address is public (assertPublic), asked before every request.
export async function callModel({ key, model, step, sectionId, system, user, json = false, maxTokens = 1000, temperature = 0.2, fetchImpl = globalThis.fetch, meter, endpoints, guard }) {
	if (key.provider === "typesafe") throw new ProviderError("TypeSafe can score and check, not write: pick another key for this step", { provider: key.provider });
	resolveBaseUrl(key, endpoints);
	const input = `${system}${user}`;
	meter.admit({ step, sectionId, provider: key.provider, model, input, maxTokens });
	const run = key.provider === "anthropic" ? anthropicMessages : chatCompletions;
	const attempt = async (jsonMode, tokens = maxTokens) => {
		try {
			return await run({ key, model, system, user, json: jsonMode, maxTokens: tokens, temperature, fetchImpl, endpoints, guard });
		} catch (error) {
			if (error instanceof ProviderError) throw error;
			throw new ProviderError(`${key.provider} failed: ${errorLine(error?.message, secretOf(key))}`, { provider: key.provider });
		}
	};
	let result;
	try {
		result = await attempt(json);
	} catch (error) {
		if (!json || key.provider === "anthropic" || !isJsonValidationFailure(error)) throw error;
		// The refused call may still have been billed for what it generated: it is recorded at its ceiling, then the second is
		// held to the cap like any call.
		meter.record({ step, sectionId, provider: key.provider, model, usage: {}, input, output: "", maxTokens });
		meter.admit({ step, sectionId, provider: key.provider, model, input, maxTokens });
		result = await attempt(false);
	}
	let call = meter.record({ step, sectionId, provider: key.provider, model, usage: result.usage, input, output: result.text, maxTokens });
	// An answer cut off at its cap with nothing usable in it (reasoning that ran long) is asked once more with twice the room,
	// held to the cap like any call.
	const unusable = (answer) => (json ? parseJsonAnswer(answer.text) === null : !String(answer.text ?? "").trim());
	if (result.finishReason === "length" && unusable(result)) {
		meter.admit({ step, sectionId, provider: key.provider, model, input, maxTokens: maxTokens * 2 });
		result = await attempt(json, maxTokens * 2);
		call = meter.record({ step, sectionId, provider: key.provider, model, usage: result.usage, input, output: result.text, maxTokens: maxTokens * 2 });
	}
	return { text: result.text, json: json ? parseJsonAnswer(result.text) : undefined, call };
}

// One System One request: { answers, call }. Output tokens are free, so the estimate is the input alone.
export async function callTypeSafe({ key, model, step, sectionId, state, questions, fetchImpl = globalThis.fetch, meter, endpoints, guard }) {
	const secret = secretOf(key);
	const body = { model, state, questions };
	const input = JSON.stringify(body);
	const base = resolveBaseUrl(key, endpoints);
	meter.admit({ step, sectionId, provider: "typesafe", model, input, maxTokens: 0 });
	let answer;
	try {
		answer = await postJson({ url: withVersion(base, "/systemone"), headers: { authorization: `Bearer ${secret}` }, body, provider: "typesafe", secret, fetchImpl, guard });
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(`typesafe failed: ${errorLine(error?.message, secret)}`, { provider: "typesafe" });
	}
	const usage = { inputTokens: numberOr(answer?.usage?.input_tokens) ?? estimateTokens(input), outputTokens: numberOr(answer?.usage?.output_tokens) ?? 0 };
	const call = meter.record({ step, sectionId, provider: "typesafe", model, usage, input, maxTokens: 0 });
	return { answers: answer?.answers ?? {}, call };
}
