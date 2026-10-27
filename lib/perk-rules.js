import { getNewsletterTiers, getTierIdsAtLeast } from "./tier-rules.js";
import { isInPaidTiers, isPaidContact } from "./tiers.js";
export function canReadPerk(newsletter, contact, perk) {
	if (!contact || contact.status !== "active" || !isPaidContact(contact) || perk.archived) return false;
	if (!perk.tierId) return true;
	const allowed = getTierIdsAtLeast(getNewsletterTiers(newsletter), perk.tierId);
	return allowed.length > 0 && isInPaidTiers(contact, allowed);
}
export function readerPerks(newsletter, contact) { return (newsletter.perks ?? []).filter((perk) => canReadPerk(newsletter, contact, perk)); }
