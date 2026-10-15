import "server-only";
import { findOwnerEmail } from "@/lib/accounts";
import { resolveFrom, withActiveProvider } from "@/lib/sender-rules";
import { refreshSharedSender } from "@/lib/shared-sender";
import Domain from "@/models/Domain";

export async function findAccountDomains(accountId) {
	const domains = await Domain.find({ accountId })
		.select({ domain: 1, verified: 1, provider: 1, dkimStatus: 1, mailFromDomain: 1, mailFromStatus: 1, archiveHost: 1, archiveHostVerified: 1 })
		.lean();
	return domains.map((domain) => withActiveProvider(domain));
}

// Who an account's newsletter may send as: { identity, replyTo } or { problem }. Every kind of email asks.
export async function loadSender(account, newsletter) {
	const [domains, ownerEmail, current] = await Promise.all([
		findAccountDomains(account._id),
		findOwnerEmail(account._id),
		refreshSharedSender(account, newsletter),
	]);
	return resolveFrom({ newsletter: current, domains, ownerEmail });
}

// Once per batch or test: newsletters of one account share its domains and owner.
export function createSenderCache(account) {
	const senders = new Map();
	return (newsletter) => {
		const key = String(newsletter._id);
		if (!senders.has(key)) senders.set(key, loadSender(account, newsletter));
		return senders.get(key);
	};
}
