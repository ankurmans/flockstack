// A newsletter's paid tiers: up to MAX_PAID_TIERS, kept in order from the lowest to the highest, each with the prices
// it asks per interval. A newsletter from before tiers has one paid tier in `paidTier` (monthly and yearly prices):
// getNewsletterTiers shows it as a tier named "Paid subscription" with the id "paid", and nothing is rewritten until
// its owner changes tiers. Contacts that were paid before tiers have no paidTierId and hold that tier.
export const MAX_PAID_TIERS = 3;
export const LEGACY_TIER_ID = "paid";
export const LEGACY_TIER_NAME = "Paid subscription";
export const TIER_ID_PATTERN = /^[a-z0-9_]{1,24}$/;
export const MAX_BENEFITS = 10;
// A lifetime reader is paid until this day; the paid period's end is what every audience query reads.
export const LIFETIME_END = new Date("2099-12-31T00:00:00.000Z");

// month, quarter, year: recurring, on Stripe's month and year intervals (a quarter is 3 months). lifetime: one payment.
// pwyw: the reader names the price, at least minCents, on the tier's pwyw interval.
export const TIER_OPTIONS = ["month", "quarter", "year", "lifetime", "pwyw"];
export const PRICE_INTERVALS = ["month", "quarter", "year", "lifetime"];
export const STRIPE_INTERVALS = {
	month: { interval: "month", interval_count: 1 },
	quarter: { interval: "month", interval_count: 3 },
	year: { interval: "year", interval_count: 1 },
};
export const OPTION_LABELS = { month: "Monthly", quarter: "Quarterly", year: "Yearly", lifetime: "Lifetime", pwyw: "Pay what you want" };
export const OPTION_NOTES = { month: "a month", quarter: "a quarter", year: "a year", lifetime: "once" };

const EMPTY_PRICES = { month: 0, quarter: 0, year: 0, lifetime: 0 };

export function makeTierId() {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return `t_${[...bytes].map((byte) => (byte % 36).toString(36)).join("")}`;
}

function normalizeTier(tier) {
	return {
		id: tier.id,
		name: tier.name ?? "",
		description: tier.description ?? "",
		benefits: [...(tier.benefits ?? [])],
		prices: { ...EMPTY_PRICES, ...tier.prices },
		pwyw: { enabled: Boolean(tier.pwyw?.enabled), minCents: tier.pwyw?.minCents ?? 0, interval: tier.pwyw?.interval ?? "year" },
		founding: { enabled: Boolean(tier.founding?.enabled), cap: tier.founding?.cap ?? null },
		archived: Boolean(tier.archived),
		stripe: tier.stripe ?? {},
	};
}

// The newsletter's tiers from the lowest to the highest. A newsletter with prices in `paidTier` and no tiers of its own has
// the one it always had.
export function getNewsletterTiers(newsletter) {
	if (newsletter?.paidTiers?.length) return newsletter.paidTiers.map(normalizeTier);
	const legacy = newsletter?.paidTier;
	if (!legacy || !(legacy.monthlyCents > 0 || legacy.yearlyCents > 0)) return [];
	return [
		normalizeTier({
			id: LEGACY_TIER_ID,
			name: LEGACY_TIER_NAME,
			prices: { month: legacy.monthlyCents ?? 0, year: legacy.yearlyCents ?? 0 },
		}),
	];
}

export function hasStoredTiers(newsletter) {
	return Boolean(newsletter?.paidTiers?.length);
}

export function findTier(tiers, id) {
	return tiers.find((tier) => tier.id === id) ?? null;
}

// The tiers readers can pick on the subscribe page: not archived, with a price.
export function getOfferedTiers(tiers) {
	return tiers.filter((tier) => !tier.archived && getTierOptions(tier).length > 0);
}

// Each way to pay for a tier, in the order the subscribe page lists them: { option, cents, mode, stripe }. cents is the
// price, or the minimum for pwyw.
export function getTierOptions(tier) {
	const options = PRICE_INTERVALS.filter((option) => tier.prices?.[option] > 0).map((option) => ({
		option,
		cents: tier.prices[option],
		mode: option === "lifetime" ? "payment" : "subscription",
	}));
	if (tier.pwyw?.enabled && tier.pwyw.minCents > 0) {
		options.push({ option: "pwyw", cents: tier.pwyw.minCents, mode: "subscription", interval: tier.pwyw.interval });
	}
	return options;
}

// The Stripe interval a recurring option bills on, or null for a one-time payment.
export function getBillingInterval(tier, option) {
	if (option === "pwyw") return STRIPE_INTERVALS[tier.pwyw?.interval ?? "year"] ?? STRIPE_INTERVALS.year;
	return STRIPE_INTERVALS[option] ?? null;
}

// What a contact's paidInterval says for an option the reader paid.
export function getContactInterval(tier, option) {
	return option === "pwyw" ? (tier.pwyw?.interval ?? "year") : option;
}

export function getTierRank(tiers, id) {
	return tiers.findIndex((tier) => tier.id === id);
}

// The tiers from this one up: a paid issue for "a tier or higher" reaches their readers.
export function getTierIdsAtLeast(tiers, id) {
	const rank = getTierRank(tiers, id);
	return rank < 0 ? [] : tiers.slice(rank).map((tier) => tier.id);
}

// The tier a paid contact holds. One from before tiers has no id and holds the legacy tier, which stays while anyone
// holds it (a tier with readers can't be deleted).
export function getContactTierId(contact) {
	return contact?.paidTierId || LEGACY_TIER_ID;
}

// The audience filter for a set of tier ids: contacts with no tier id yet hold the legacy tier.
export function tierIdFilter(ids) {
	const wanted = [...new Set(ids)];
	return wanted.includes(LEGACY_TIER_ID) ? { $or: [{ paidTierId: { $in: wanted } }, { paidTierId: null }] } : { paidTierId: { $in: wanted } };
}

// What a tier's prices look like to a reader: "$8 a month, $80 a year".
export function describePrices(tier, formatPrice, currency) {
	const parts = PRICE_INTERVALS.filter((option) => tier.prices?.[option] > 0).map((option) => `${formatPrice(tier.prices[option], currency)} ${OPTION_NOTES[option]}`);
	if (tier.pwyw?.enabled) parts.push(`${formatPrice(tier.pwyw.minCents, currency)} or more ${tier.pwyw.interval === "month" ? "a month" : "a year"}`);
	return parts.join(", ");
}
