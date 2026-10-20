// Gift subscriptions: pure rules. A gift is months of one paid tier, bought once.
export const GIFT_MONTHS = [1, 3, 6, 12];
// A gift can be redeemed for this long after it was bought, delivery date included. After that it expires: the money stays
// with the writer (a refund is theirs to make in Stripe), and the recipient's link says so. The gift's months start when it is
// redeemed, so redeeming late costs the recipient nothing.
export const GIFT_REDEEM_MONTHS = 12;
export const MAX_DELIVERY_DAYS = 365;
export const MAX_MESSAGE_LENGTH = 500;

export function addMonths(date, months) {
	const next = new Date(date);
	next.setUTCMonth(next.getUTCMonth() + months);
	return next;
}

export function getGiftExpiry(paidAt) {
	return addMonths(paidAt, GIFT_REDEEM_MONTHS);
}

// What a gift of some months costs for a tier, in cents, or 0 when the tier can't be given for that long: a year is the yearly
// price, a quarter the quarterly price, and the rest are months of the monthly price. Never a lifetime or a pay what you want tier.
export function getGiftPrice(tier, months) {
	const { month = 0, quarter = 0, year = 0 } = tier.prices ?? {};
	if (months === 12) return year > 0 ? year : month * 12;
	if (months === 3) return quarter > 0 ? quarter : month * 3;
	return month * months;
}

export function getGiftOptions(tier) {
	return GIFT_MONTHS.map((months) => ({ months, cents: getGiftPrice(tier, months) })).filter(({ cents }) => cents > 0);
}

// "2027-01-31" read as the start of that day, UTC; null when it isn't a day.
export function readDeliveryDay(text) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text ?? ""))) return null;
	const date = new Date(`${text}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().startsWith(text) ? date : null;
}

export function getGiftState(gift, now = Date.now()) {
	if ((gift.status === "paid" || gift.status === "sent") && gift.expiresAt && new Date(gift.expiresAt).getTime() <= now) return "expired";
	return gift.status;
}
