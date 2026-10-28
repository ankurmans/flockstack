import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { AI_PROVIDERS, BRIEFING_STEPS, MAX_AI_KEYS_PER_ACCOUNT } from "@/lib/briefing-rules";
import { decryptSecret, encryptSecret } from "@/lib/credentials";
import { connectDb } from "@/lib/db";
import { ObjectId } from "@/lib/docdb";
import { isObjectIdString } from "@/lib/validation";
import { getPrivateHostProblem } from "@/lib/webhook-url";
import AiProviderKey from "@/models/AiProviderKey";
import Briefing from "@/models/Briefing";

// An account's own keys for AI providers (models/AiProviderKey.js), used by its briefings (docs/BRIEFINGS-DESIGN.md). The key is
// encrypted with lib/credentials.js the moment it arrives and leaves this module only through getAiKeyForRun, for the briefings
// engine's call to the provider it was saved for: no answer, error, log line or export carries it.

// Where each provider's API is. {accountRef} is the user's own Cloudflare account ID; openai-compatible has the key's own baseUrl.
export const AI_PROVIDER_ENDPOINTS = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
	together: "https://api.together.xyz/v1",
	deepinfra: "https://api.deepinfra.com/v1/openai",
	fireworks: "https://api.fireworks.ai/inference/v1",
	mistral: "https://api.mistral.ai/v1",
	deepseek: "https://api.deepseek.com/v1",
	cloudflare: "https://api.cloudflare.com/client/v4/accounts/{accountRef}/ai/v1",
	typesafe: "https://api.typesafe.ai/v1",
};

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
};

const ACCOUNT_REF_PATTERN = /^[a-f0-9]{32}$/i;
// Printable characters only, with no spaces: what every provider's keys are made of.
const SECRET_PATTERN = /^[\x21-\x7e]+$/;
export const MIN_AI_KEY_LENGTH = 8;
export const MAX_AI_KEY_LENGTH = 512;
const CHECK_TIMEOUT_MS = 8_000;

function getContext(accountId, keyId) {
	return { context: `ai-key:${accountId}:${keyId}` };
}

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
	if (!AI_PROVIDERS.includes(provider)) return "Choose the provider";
	const secret = String(key ?? "").trim();
	if (secret.length < MIN_AI_KEY_LENGTH || secret.length > MAX_AI_KEY_LENGTH || !SECRET_PATTERN.test(secret)) {
		return `Paste the whole key: ${MIN_AI_KEY_LENGTH} to ${MAX_AI_KEY_LENGTH} characters, with no spaces`;
	}
	if (provider === "openai-compatible") return getAiBaseUrlProblem(baseUrl);
	if (baseUrl) return "Only another OpenAI-compatible server takes an address";
	if (provider === "cloudflare" && !ACCOUNT_REF_PATTERN.test(String(accountRef ?? "").trim())) return "Enter your Cloudflare account ID: 32 letters and digits, on the dashboard's Workers AI page";
	if (provider !== "cloudflare" && accountRef) return "Only Cloudflare takes an account ID";
	return null;
}

// The API address the key is used at.
export function getAiKeyBaseUrl({ provider, baseUrl, accountRef }) {
	if (provider === "openai-compatible") return String(baseUrl ?? "").replace(/\/+$/, "");
	return AI_PROVIDER_ENDPOINTS[provider].replace("{accountRef}", String(accountRef ?? ""));
}

// A key as the actions show it: what tells keys apart, never the key.
export function toAiKey(doc, usedBy = 0) {
	return {
		id: String(doc._id),
		name: doc.name,
		provider: doc.provider,
		providerLabel: AI_PROVIDER_LABELS[doc.provider] ?? doc.provider,
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

// The briefings of the account whose steps use each key: key id -> how many.
async function countUses(account) {
	const briefings = await Briefing.find(scoped(account)).select({ steps: 1 }).lean();
	const counts = new Map();
	for (const briefing of briefings) {
		const ids = new Set(BRIEFING_STEPS.map((step) => briefing.steps?.[step]?.keyId).filter(Boolean).map(String));
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
		encrypted = encryptSecret(secret, getContext(account._id, _id));
	} catch {
		throw actionError("unavailable", "This server's CREDENTIALS_ENCRYPTION_KEY isn't 32 random bytes in base64 or hex, so it can't keep AI keys");
	}
	const doc = await AiProviderKey.create({
		_id,
		accountId: account._id,
		name: input.name.trim(),
		provider: input.provider,
		...(input.provider === "openai-compatible" && { baseUrl: getAiKeyBaseUrl(input) }),
		...(input.provider === "cloudflare" && { accountRef: input.accountRef.trim().toLowerCase() }),
		secret: encrypted,
		hint: secret.slice(-4),
		status: "unchecked",
		...(createdBy && { createdBy: String(createdBy) }),
	});
	return toAiKey(doc.toObject());
}

// The one authenticated request that says whether a provider takes the key, the cheapest each has: its list of models, or
// OpenRouter's key endpoint (its list of models answers without one).
function buildCheckRequest(doc, secret) {
	const base = getAiKeyBaseUrl(doc);
	if (doc.provider === "anthropic") return { url: `${base}/models?limit=1`, headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" } };
	if (doc.provider === "openrouter") return { url: `${base}/key`, headers: { authorization: `Bearer ${secret}` } };
	if (doc.provider === "cloudflare") return { url: `https://api.cloudflare.com/client/v4/accounts/${doc.accountRef}/ai/models/search?per_page=1`, headers: { authorization: `Bearer ${secret}` } };
	return { url: `${base}/models`, headers: { authorization: `Bearer ${secret}` } };
}

// Asks the provider whether it takes the key: ok, or rejected when it answers 401 or 403. Anything else (a timeout, a 500) leaves
// the status as it was and answers unavailable. Nothing of the provider's answer is kept or repeated: it could echo the key.
export async function checkAiKey(account, id, { now = new Date() } = {}) {
	const found = await findAiKey(account, id);
	const doc = await AiProviderKey.findOne(scoped(account, { _id: found._id })).select("+secret").lean();
	if (doc.provider === "openai-compatible" && getAiBaseUrlProblem(doc.baseUrl)) throw actionError("validation_failed", getAiBaseUrlProblem(doc.baseUrl));
	let secret;
	try {
		secret = decryptSecret(doc.secret, getContext(account._id, doc._id));
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
	if (!verdict) throw actionError("unavailable", `${label} answered ${status}, which says nothing about the key: try again later`);
	await AiProviderKey.updateOne(scoped(account, { _id: doc._id }), { $set: { status: verdict, checkedAt: now } });
	const uses = await countUses(account);
	return {
		key: toAiKey({ ...found, status: verdict, checkedAt: now }, uses.get(String(doc._id)) ?? 0),
		problem: verdict === "rejected" ? `${label} refused the key: it may be revoked, mistyped or without access to its models` : null,
	};
}

// Deletes the key and its ciphertext at once. Refused while a briefing's step uses it, so no briefing is left without a key.
export async function deleteAiKey(account, id) {
	const doc = await findAiKey(account, id);
	const used = (await countUses(account)).get(String(doc._id)) ?? 0;
	if (used > 0) throw actionError("conflict", `A briefing uses this key (${used === 1 ? "1 briefing" : `${used} briefings`}): choose another key for its steps first`);
	await AiProviderKey.deleteOne(scoped(account, { _id: doc._id }));
	return { id: String(doc._id), deleted: true };
}

// For the briefings engine only: the key in the clear, with where to send it. Never log or return what this gives.
export async function getAiKeyForRun({ accountId, keyId }) {
	if (!isObjectIdString(String(keyId ?? ""))) return null;
	await connectDb();
	const doc = await AiProviderKey.findOne(scoped(accountId, { _id: keyId })).select("+secret").lean();
	if (!doc) return null;
	return {
		provider: doc.provider,
		baseUrl: getAiKeyBaseUrl(doc),
		accountRef: doc.accountRef ?? null,
		secret: decryptSecret(doc.secret, getContext(accountId, doc._id)),
	};
}

export async function markAiKeyUsed({ accountId, keyId, at = new Date() }) {
	if (!isObjectIdString(String(keyId ?? ""))) return;
	await connectDb();
	await AiProviderKey.updateOne(scoped(accountId, { _id: keyId }), { $set: { lastUsedAt: at } });
}
