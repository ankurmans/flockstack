import { scoped } from "../account-scope.js";
import AiProviderKey from "../../models/AiProviderKey.js";

// The key store (lib/ai-keys.js: decrypts a key for a run, knows each provider's address), read only when a run needs a key.
// runTick takes getKey, markKeyUsed and endpoints as options too, so a test or a caller can hand in its own.
export async function loadKeyStore() {
	const keys = await import("../ai-keys.js");
	return { getKey: keys.getAiKeyForRun, markKeyUsed: keys.markAiKeyUsed, endpoints: keys.AI_PROVIDER_ENDPOINTS };
}

// A key its provider refused during a run: marked rejected, as check_ai_key would, so the dashboard shows it.
export async function markKeyRejected({ accountId, keyId, at = new Date() }) {
	await AiProviderKey.updateOne(scoped(accountId, { _id: keyId }), { $set: { status: "rejected", checkedAt: at } });
}
