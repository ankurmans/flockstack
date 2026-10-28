import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { AI_PROVIDERS, BRIEFING_STEPS, MAX_AI_KEYS_PER_ACCOUNT, SEARCH_PROVIDERS } from "@/lib/briefing-rules";
import { AI_PROVIDER_ENDPOINTS, BASE_URL_PROVIDERS, getAiKeyBaseUrl, getAiKeyContext, readAiKeyForRun, touchAiKey } from "@/lib/ai-key-reader";
import { decryptSecret, encryptSecret } from "@/lib/credentials";
import { connectDb } from "@/lib/db";
import { ObjectId } from "@/lib/docdb";
import { getResolvedHostProblem } from "@/lib/public-host";
import { isObjectIdString } from "@/lib/validation";
import { getPrivateHostProblem } from "@/lib/webhook-url";
import AiProviderKey from "@/models/AiProviderKey";
import Briefing from "@/models/Briefing";

// An account's own keys for AI and search providers (models/AiProviderKey.js), used by its briefings (docs/BRIEFINGS-DESIGN.md). The key is
// encrypted with lib/credentials.js the moment it arrives and leaves this module only through getAiKeyForRun, for the briefings
// engine's call to the provider it was saved for: no answer, error, log line or export carries it.

export { AI_PROVIDER_ENDPOINTS, getAiKeyBaseUrl } from "@/lib/ai-key-reader";

// TinyFish's APIs (docs.tinyfish.ai, checked 2026-10-28), each with the key in an X-API-Key header: GET search?query=, POST fetch, and
// the account API, whose list of runs is the cheapest request that needs a valid key.
export const TINYFISH_ENDPOINTS = { search: "https://api.search.tinyfish.ai", fetch: "https://api.fetch.tinyfish.ai", account: "https://agent.tinyfish.ai/v1" };

export const ALL_KEY_PROVIDERS = [...AI_PROVIDERS, ...SEARCH_PROVIDERS];
// Search keys go in a briefing's discovery, model keys in its steps, never the other way round.
export function isSearchProvider(provider) {
	return SEARCH_PROVIDERS.includes(provider);
}

export const AI_PROVIDER_LABELS = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	gemini: "Google Gemini",
	openrouter: "OpenRouter",
	groq: "Groq",
	together: "Together AI",
	deepinfra: "DeepInfra",
	fireworks: "Fireworks",
	mistral: "Mistral",
	deepseek: "DeepSeek",
	cloudflare: "Cloudflare Workers AI",
	typesafe: "TypeSafe",
	"openai-compatible": "Another OpenAI-compatible server",
	tinyfish: "TinyFish",
	"candidate-feed": "Candidate feed",
};

const ACCOUNT_REF_PATTERN = /^[a-f0-9]{32}$/i;
// Printable characters only, with no spaces: what every provider's keys are made of.
const SECRET_PATTERN = /^[\x21-\x7e]+$/;
export const MIN_AI_KEY_LENGTH = 8;
export const MAX_AI_KEY_LENGTH = 512;
const CHECK_TIMEOUT_MS = 8_000;

const getContext = getAiKeyContext;

// What's wrong with an openai-compatible server's address, or null. The engine calls it from FlockStack's servers, so it is the
// rule every fetch for a customer follows: https on the default port to a public host.
export function getAiBaseUrlProblem(value) {
	const text = String(value ?? "").trim();
	if (!text) return "Enter the server's address, like https://llm.example.com/v1";
	if (text.length > 500) return "The address can be 500 characters at most";
	let url;
	try {
		url = new URL(text);
	} catch {
		return "Enter a full address, starting with https://";
	}
	if (url.protocol !== "https:") return "The server's address has to start with https://";
	if (url.username || url.password) return "Leave the user name and password out of the address";
	if (url.port) return "Use the default https port: leave the port out of the address";
	if (url.search || url.hash) return "Leave anything after ? or # out of the address";
	return getPrivateHostProblem(url);
}

// What's wrong with a new key's fields, or null. Never repeats the key itself.
export function getAiKeyProblem({ name, provider, baseUrl, accountRef, key }) {
	if (!String(name ?? "").trim()) return "Name the key";
	if (!ALL_KEY_PROVIDERS.includes(provider)) return "Choose the provider";
	const secret = String(key ?? "").trim();
	if (secret.length < MIN_AI_KEY_LENGTH || secret.length > MAX_AI_KEY_LENGTH || !SECRET_PATTERN.test(secret)) {
		return `Paste the whole key: ${MIN_AI_KEY_LENGTH} to ${MAX_AI_KEY_LENGTH} characters, with no spaces`;
	}
	if (BASE_URL_PROVIDERS.includes(provider)) return getAiBaseUrlProblem(baseUrl);
	if (baseUrl) return "Only another OpenAI-compatible server or a candidate feed takes an address";
	if (provider === "cloudflare" && !ACCOUNT_REF_PATTERN.test(String(accountRef ?? "").trim())) return "Enter your Cloudflare account ID: 32 letters and digits, on the dashboard's Workers AI page";
	if (provider !== "cloudflare" && accountRef) return "Only Cloudflare takes an account ID";
	return null;
}

// The API address the key is used at.

// A key as the actions show it: what tells keys apart, never the key.
export function toAiKey(doc, usedBy = 0) {
	return {
		id: String(doc._id),
		name: doc.name,
		provider: doc.provider,
		providerLabel: AI_PROVIDER_LABELS[doc.provider] ?? doc.provider,
		kind: isSearchProvider(doc.provider) ? "search" : "model",
		baseUrl: doc.baseUrl ?? null,
		accountRef: doc.accountRef ?? null,
		hint: doc.hint,
		status: doc.status ?? "unchecked",
		checkedAt: doc.checkedAt ? new Date(doc.checkedAt).toISOString() : null,
		lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
		usedBy,
		createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
	};
}

// The briefings of the account whose steps or discovery use each key: key id -> how many.
async function countUses(account) {
	const briefings = await Briefing.find(scoped(account)).select({ steps: 1, discovery: 1 }).lean();
	const counts = new Map();
	for (const briefing of briefings) {
		const ids = new Set([...BRIEFING_STEPS.map((step) => briefing.steps?.[step]?.keyId), briefing.discovery?.searchKeyId, briefing.discovery?.candidateFeedKeyId].filter(Boolean).map(String));
		for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

export async function findAiKey(account, id) {
	const doc = isObjectIdString(String(id ?? "")) ? await AiProviderKey.findOne(scoped(account, { _id: id })).lean() : null;
	if (!doc) throw actionError("not_found", "AI key not found");
	return doc;
}

export async function listAiKeys(account) {
	const [docs, uses] = await Promise.all([AiProviderKey.find(scoped(account)).sort({ createdAt: 1, _id: 1 }).lean(), countUses(account)]);
	return docs.map((doc) => toAiKey(doc, uses.get(String(doc._id)) ?? 0));
}

// Encrypts the key and saves it. Without CREDENTIALS_ENCRYPTION_KEY the server has no way to keep it, and says so.
export async function addAiKey(account, input, { createdBy = null } = {}) {
	const problem = getAiKeyProblem(input);
	if (problem) throw actionError("validation_failed", problem);
	if (!String(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "").trim()) {
		throw actionError("unavailable", "This server can't keep AI keys yet: the owner has to set CREDENTIALS_ENCRYPTION_KEY first");
	}
	if ((await AiProviderKey.countDocuments(scoped(account))) >= MAX_AI_KEYS_PER_ACCOUNT) {
		throw actionError("conflict", `An account has ${MAX_AI_KEYS_PER_ACCOUNT} AI keys at most: delete one first`);
	}
	const secret = input.key.trim();
	const _id = new ObjectId();
	let encrypted;
	try {
		encrypted = encryptSecret(secret, getContext(account._id, _id, { provider: input.provider, baseUrl: getAiKeyBaseUrl(input), accountRef: input.accountRef }));
	} catch {
		throw actionError("unavailable", "This server's CREDENTIALS_ENCRYPTION_KEY isn't 32 random bytes in base64 or hex, so it can't keep AI keys");
	}
	const doc = await AiProviderKey.create({
		_id,
		accountId: account._id,
		name: input.name.trim(),
		provider: input.provider,
		...(BASE_URL_PROVIDERS.includes(input.provider) && { baseUrl: getAiKeyBaseUrl(input) }),
		...(input.provider === "cloudflare" && { accountRef: input.accountRef.trim().toLowerCase() }),
		secret: encrypted,
		hint: secret.slice(-4),
		status: "unchecked",
		...(createdBy && { createdBy: String(createdBy) }),
	});
	return toAiKey(doc.toObject());
}

// The one authenticated request that says whether a provider takes the key, the cheapest each has: its list of models, OpenRouter's
// key endpoint (its list of models answers without one), TinyFish's list of runs (a search would use up the free tier), or the
// candidate feed itself.
function buildCheckRequest(doc, secret) {
	const base = getAiKeyBaseUrl(doc);
	if (doc.provider === "tinyfish") return { url: `${TINYFISH_ENDPOINTS.account}/runs?limit=1`, headers: { "x-api-key": secret } };
	if (doc.provider === "candidate-feed") return { url: base, headers: { authorization: `Bearer ${secret}` } };
	if (doc.provider === "anthropic") return { url: `${base}/models?limit=1`, headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" } };
	if (doc.provider === "openrouter") return { url: `${base}/key`, headers: { authorization: `Bearer ${secret}` } };
	if (doc.provider === "cloudflare") return { url: `https://api.cloudflare.com/client/v4/accounts/${doc.accountRef}/ai/models/search?per_page=1`, headers: { authorization: `Bearer ${secret}` } };
	return { url: `${base}/models`, headers: { authorization: `Bearer ${secret}` } };
}

// Asks the provider whether it takes the key: ok, or rejected when it answers 401 or 403. Anything else (a redirect, a timeout, a
// 500) leaves the status as it was and answers unavailable. Nothing of the answer is kept or repeated, not even its status: it could
// echo the key, and the address can be the account's own. That address is resolved first and every address it has must be public,
// so a key is never sent into a private network (a self-hosted server has no strictly-public fetch to rely on).
export async function checkAiKey(account, id, { now = new Date() } = {}) {
	const found = await findAiKey(account, id);
	const doc = await AiProviderKey.findOne(scoped(account, { _id: found._id })).select("+secret").lean();
	if (BASE_URL_PROVIDERS.includes(doc.provider)) {
		const problem = getAiBaseUrlProblem(doc.baseUrl) ?? (await getResolvedHostProblem(new URL(doc.baseUrl)));
		if (problem) throw actionError("validation_failed", problem);
	}
	let secret;
	try {
		secret = decryptSecret(doc.secret, getContext(account._id, doc._id, doc));
	} catch {
		throw actionError("unavailable", "The key doesn't decrypt on this server: CREDENTIALS_ENCRYPTION_KEY changed. Delete it and add it again.");
	}
	const label = AI_PROVIDER_LABELS[doc.provider] ?? "The provider";
	const { url, headers } = buildCheckRequest(doc, secret);
	let status;
	try {
		const response = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "manual", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
		status = response.status;
		await response.body?.cancel().catch(() => {});
	} catch {
		throw actionError("unavailable", `${label} didn't answer: try again in a minute`);
	}
	const verdict = status >= 200 && status < 300 ? "ok" : status === 401 || status === 403 ? "rejected" : null;
	if (!verdict) throw actionError("unavailable", `${label} didn't give an answer that says whether it takes the key: try again later`);
	await AiProviderKey.updateOne(scoped(account, { _id: doc._id }), { $set: { status: verdict, checkedAt: now } });
	const uses = await countUses(account);
	return {
		key: toAiKey({ ...found, status: verdict, checkedAt: now }, uses.get(String(doc._id)) ?? 0),
		problem: verdict === "rejected" ? `${label} refused the key: it may be revoked, mistyped or without access to its models` : null,
	};
}

// Deletes the key and its ciphertext at once. Refused while a briefing's step or discovery uses it, so no briefing is left without a key.
export async function deleteAiKey(account, id) {
	const doc = await findAiKey(account, id);
	const used = (await countUses(account)).get(String(doc._id)) ?? 0;
	if (used > 0) throw actionError("conflict", `A briefing uses this key (${used === 1 ? "1 briefing" : `${used} briefings`}): choose another key for its steps or discovery first`);
	await AiProviderKey.deleteOne(scoped(account, { _id: doc._id }));
	return { id: String(doc._id), deleted: true };
}

// For the briefings engine only (lib/ai-key-reader.js): the key in the clear, with where to send it. Never log or return what this gives.
export async function getAiKeyForRun(input) {
	await connectDb();
	return readAiKeyForRun(input);
}

export async function markAiKeyUsed(input) {
	await connectDb();
	return touchAiKey(input);
}
