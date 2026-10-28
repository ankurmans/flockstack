import { scoped } from "../account-scope.js";
import { AI_PROVIDER_ENDPOINTS, readAiKeyForRun, touchAiKey } from "../ai-key-reader.js";
import AiProviderKey from "../../models/AiProviderKey.js";

// The engine reads keys through lib/ai-key-reader.js, the same reader as the key store (lib/ai-keys.js), without loading the store.
// runTick takes getKey, markKeyUsed and endpoints as options, so a test or a caller can hand in its own.
export const PROVIDER_ENDPOINTS = AI_PROVIDER_ENDPOINTS;
export const getKeyForRun = readAiKeyForRun;
export const markKeyUsed = touchAiKey;

export function loadKeyStore() {
	return { getKey: getKeyForRun, markKeyUsed, endpoints: PROVIDER_ENDPOINTS };
}

// A key its provider refused during a run: marked rejected, as check_ai_key would, so the dashboard shows it.
export async function markKeyRejected({ accountId, keyId, at = new Date() }) {
	await AiProviderKey.updateOne(scoped(accountId, { _id: keyId }), { $set: { status: "rejected", checkedAt: at } });
}
