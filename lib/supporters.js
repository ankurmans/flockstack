import "server-only";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { audienceTierFilter } from "@/lib/tiers";
import { getNewsletterTiers, tierIdFilter } from "@/lib/tier-rules";
import Contact from "@/models/Contact";

const LIST_LIMIT = 500;

// Founding members: the active readers paid in a founding tier, whoever pays them (a comp or a gift takes a spot too).
export function countFoundingMembers(account, newsletter, tier) {
	return Contact.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid", Date.now(), tierIdFilter([tier.id])) }));
}

// A founding tier with a cap stops taking members when it is full. Checked as a reader starts paying, so two readers
// finishing Checkout at once can take it a member past its cap: the cap is a promise to readers, not a lock.
export async function assertFoundingSpot({ account, newsletter, tier }) {
	if (!tier.founding?.enabled || !tier.founding.cap) return;
	if ((await countFoundingMembers(account, newsletter, tier)) >= tier.founding.cap) {
		throw codedError({ code: "conflict", message: `All ${tier.founding.cap} founding spots are taken` });
	}
}

function getFoundingIds(newsletter) {
	return getNewsletterTiers(newsletter)
		.filter((tier) => tier.founding.enabled)
		.map((tier) => tier.id);
}

// Founding members, oldest first. named: only those who gave a name for the supporters list, which is all a public page may show.
export async function listFoundingMembers(account, newsletter, { named = false } = {}) {
	const ids = getFoundingIds(newsletter);
	if (ids.length === 0) return [];
	return Contact.find(scoped(account, { newsletterId: newsletter._id, status: "active", ...(named && { supporterName: { $exists: true } }), ...audienceTierFilter("paid", Date.now(), tierIdFilter(ids)) }))
		.sort({ paidSince: 1, _id: 1 })
		.limit(LIST_LIMIT)
		.select({ email: 1, supporterName: 1, paidTierId: 1, paidSince: 1 })
		.lean();
}

// The names on a newsletter's public supporters list: only when its owner turned the list on, and only names readers gave.
export async function listPublicSupporters(account, newsletter) {
	if (!newsletter.paidTier?.supportersPublic) return [];
	return (await listFoundingMembers(account, newsletter, { named: true })).map(({ supporterName }) => supporterName);
}
