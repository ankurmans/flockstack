import { scoped } from "./account-scope.js";
import { decryptSecret } from "./credentials.js";
import AiProviderKey from "../models/AiProviderKey.js";

// The one place that knows where each provider's API is and what a stored key's ciphertext is bound to. lib/ai-keys.js (the key
// store behind the actions) and the briefings engine (lib/briefings/deps.js) both read keys through it; it is small so the
// briefings Worker can load it without the store and its action errors.

// Where each provider's API is. {accountRef} is the user's own Cloudflare account ID; openai-compatible and candidate-feed have the
// key's own baseUrl. TinyFish's search has a host of its own, and its fetch and account API others (TINYFISH_ENDPOINTS in lib/ai-keys.js).
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
	tinyfish: "https://api.search.tinyfish.ai",
};

// Providers that take the key holder's own address.
export const BASE_URL_PROVIDERS = ["openai-compatible", "candidate-feed"];

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export function getAiKeyBaseUrl({ provider, baseUrl, accountRef }) {
	if (BASE_URL_PROVIDERS.includes(provider)) return String(baseUrl ?? "").replace(/\/+$/, "");
	return String(AI_PROVIDER_ENDPOINTS[provider] ?? "").replace("{accountRef}", String(accountRef ?? ""));
}

// What the ciphertext is bound to: the account, the key, and where it may be sent. A key whose provider, address or Cloudflare
// account is changed in the database stops decrypting rather than going somewhere new.
export function getAiKeyContext(accountId, keyId, { provider, baseUrl, accountRef }) {
	const address = BASE_URL_PROVIDERS.includes(provider) ? String(baseUrl ?? "").replace(/\/+$/, "") : "";
	return { context: `ai-key:${accountId}:${keyId}:${provider}:${address}:${provider === "cloudflare" ? String(accountRef ?? "").trim().toLowerCase() : ""}` };
}

// For the briefings engine only: the key in the clear, with where to send it. Never log or return what this gives.
export async function readAiKeyForRun({ accountId, keyId }) {
	if (!OBJECT_ID.test(String(keyId ?? ""))) return null;
	const doc = await AiProviderKey.findOne(scoped(accountId, { _id: keyId })).select("+secret").lean();
	if (!doc) return null;
	return { provider: doc.provider, baseUrl: getAiKeyBaseUrl(doc), accountRef: doc.accountRef ?? null, secret: decryptSecret(doc.secret, getAiKeyContext(accountId, doc._id, doc)) };
}

export async function touchAiKey({ accountId, keyId, at = new Date() }) {
	if (!OBJECT_ID.test(String(keyId ?? ""))) return;
	await AiProviderKey.updateOne(scoped(accountId, { _id: keyId }), { $set: { lastUsedAt: at } });
}
