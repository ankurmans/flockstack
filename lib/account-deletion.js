import "server-only";
import { scoped } from "@/lib/account-scope";
import { isBlocked, isPaidStatus } from "@/lib/account-state";
import { revalidateArchive } from "@/lib/archive-data";
import { signOutEverywhere } from "@/lib/auth";
import { getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { forgetDeletion, recordDeletion } from "@/lib/deletion-records";
import { disconnectAllApps } from "@/lib/oauth";
import { getWakeAt } from "@/lib/scheduling";
import { publishJob } from "@/lib/sending";
import { resumeTenantQuietly, suspendTenantQuietly } from "@/lib/tenants";
import Account from "@/models/Account";
import ApiKey from "@/models/ApiKey";
import Campaign from "@/models/Campaign";

// How long a deleted account can be restored by signing in. Then lib/account-purge.js deletes its data for good.
export const DELETION_GRACE_DAYS = 30;
const GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
const ACTIVE_CAMPAIGN_STATUSES = ["sending", "scheduled"];
const MAX_LISTED_CAMPAIGNS = 10;

// What keeps an account from being deleted, or null: a plan Stripe still bills, which only the billing portal
// cancels, and campaigns sending or scheduled, which their owner pauses or unschedules first.
export async function getDeletionBlockers(account) {
	await connectDb();
	const campaigns = await Campaign.find(scoped(account, { status: { $in: ACTIVE_CAMPAIGN_STATUSES } }))
		.sort({ createdAt: -1 })
		.limit(MAX_LISTED_CAMPAIGNS)
		.select({ subject: 1, status: 1 })
		.lean();
	const hasPlan = isCloud() && isPaidStatus(account.subscriptionStatus);
	return hasPlan || campaigns.length > 0 ? { hasPlan, campaigns } : null;
}

// at: when QStash delivers it, the purge's own time unless it's tried again later.
export async function publishPurge({ accountId, purgeAt, at = purgeAt }) {
	await publishJob({
		url: `${getAppUrl()}/api/jobs/purge-account`,
		body: { accountId: String(accountId), purgeAt: purgeAt.toISOString() },
		notBefore: getWakeAt(at),
	});
}

// The account stops at once: its owner signed out everywhere, its API keys revoked, its connected apps disconnected,
// nothing sent (it counts as unpaid: lib/account-state.js) and its tenant suspended at the provider. The purge job
// goes out first, so the account never waits without one.
export async function requestDeletion({ account, user, now = new Date() }) {
	const purgeAt = new Date(now.getTime() + GRACE_MS);
	await publishPurge({ accountId: account._id, purgeAt });
	await recordDeletion({ account, email: user.email, requestedAt: now });
	await Account.updateOne({ _id: account._id, "deletion.requestedAt": null }, { $set: { deletion: { requestedAt: now, purgeAt } } });
	await ApiKey.updateMany(scoped(account, { revokedAt: null }), { $set: { revokedAt: now } });
	await disconnectAllApps(account);
	await Campaign.updateMany(scoped(account, { status: "scheduled" }), { $set: { status: "draft" }, $unset: { scheduledAt: 1 } });
	await Campaign.updateMany(scoped(account, { status: "sending" }), { $set: { status: "paused", pauseReason: "the account was deleted" } });
	await suspendTenantQuietly(account._id);
	revalidateArchive();
	await signOutEverywhere(user.id);
	return { purgeAt };
}

// Signing in before the purge: the account works as it did, but its API keys and connected apps stay off.
export async function restoreAccount(account) {
	await connectDb();
	const { modifiedCount } = await Account.updateOne(
		{ _id: account._id, "deletion.requestedAt": { $ne: null }, "deletion.purgeStartedAt": null },
		{ $unset: { deletion: 1 } }
	);
	if (modifiedCount === 0) return false;
	await forgetDeletion(account._id);
	if (!isBlocked(account)) await resumeTenantQuietly(account._id);
	revalidateArchive();
	return true;
}
