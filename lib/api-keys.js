import "server-only";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { findUser, isUserAllowed } from "@/lib/accounts";
import { recordActivity } from "@/lib/agent-activity";
import { isIpAllowed } from "@/lib/ip-allowlist";
import { getKeyLevel, hashApiKey, isKeyExpired, readBearerToken, shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";
import ApiKey from "@/models/ApiKey";

export { generateApiKey, getKeyLevel, hashApiKey } from "@/lib/api-key-tokens";

// The key decides the account: requests only ever reach that account's data, at the key's level. { ipBlocked: true } for a key
// used from an address its allow-list leaves out: a 403 that doesn't say which addresses are allowed.
export async function authenticateRequest(request) {
	const key = readBearerToken(request.headers.get("authorization"));
	if (!key) return null;

	await connectDb();
	const apiKey = await ApiKey.findOne({ hash: hashApiKey(key), revokedAt: null }).setOptions({ crossAccount: true }).lean();
	if (!apiKey || apiKey.purpose === "assistant" || isKeyExpired(apiKey)) return null;
	const account = await Account.findById(apiKey.accountId).lean();
	if (!account || isDeletionPending(account)) return null;
	// On a self-hosted server, an owner taken off the allowlist takes their keys with them.
	if (!isCloud() && !isUserAllowed(await findUser(account.ownerId))) return null;

	// Cloudflare sets cf-connecting-ip itself; X-Forwarded-For is whatever the caller wrote, so it never opens an allow-list.
	if (apiKey.allowedIps?.length && !isIpAllowed(request.headers.get("cf-connecting-ip"), apiKey.allowedIps)) {
		await recordActivity(account, {
			kind: "call",
			actorType: "key",
			actorId: String(apiKey._id),
			actorName: apiKey.name,
			via: new URL(request.url).pathname.startsWith("/mcp") ? "mcp" : "api",
			action: "authenticate",
			status: "denied",
			errorCode: "ip_not_allowed",
			summary: "A request from an address outside the key's allow-list",
		});
		return { ipBlocked: true };
	}

	const now = new Date();
	if (shouldTouchLastUsed(apiKey.lastUsedAt, now.getTime())) {
		await ApiKey.updateOne(scoped(account, { _id: apiKey._id }), { $set: { lastUsedAt: now } }).catch((error) =>
			console.error("[api-keys] Could not update lastUsedAt:", error.message)
		);
	}
	return { apiKey, account, level: getKeyLevel(apiKey) };
}

export function listApiKeys(account) {
	return ApiKey.find(scoped(account)).sort({ createdAt: -1 }).select("-hash").lean();
}
