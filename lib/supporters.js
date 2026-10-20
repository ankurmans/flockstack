import "server-only";
import { scoped } from "@/lib/account-scope";
import { audienceTierFilter } from "@/lib/tiers";
import { tierIdFilter } from "@/lib/tier-rules";
import Contact from "@/models/Contact";

// Founding members: the active readers paid in a founding tier, whoever pays them (a comp or a gift takes a spot too).
export function countFoundingMembers(account, newsletter, tier) {
	return Contact.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid", Date.now(), tierIdFilter([tier.id])) }));
}
