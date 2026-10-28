// The key store (lib/ai-keys.js: decrypts a key for a run, knows each provider's address), read only when a run needs a key.
// runTick takes getKey, markKeyUsed and endpoints as options too, so a test or a caller can hand in its own.
export async function loadKeyStore() {
	const keys = await import("../ai-keys.js");
	return { getKey: keys.getAiKeyForRun, markKeyUsed: keys.markAiKeyUsed, endpoints: keys.AI_PROVIDER_ENDPOINTS };
}
