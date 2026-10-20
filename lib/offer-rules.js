// Offers are discounts and trials with a link (models/Offer.js). Pure rules, shared by the actions, the offer page and its form.
export const OFFER_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const MAX_OFFERS_PER_NEWSLETTER = 50;

// The price of one payment with the offer on. The first payment's, which is what the page shows.
export function applyOffer(cents, offer) {
	if (!offer || offer.type === "trial") return cents;
	if (offer.type === "percent") return Math.max(0, Math.round((cents * (100 - offer.percentOff)) / 100));
	return Math.max(0, cents - (offer.amountOffCents ?? 0));
}

// Why a link doesn't work now, or null when it does. redemptions: how many readers took it.
export function getOfferProblem(offer, { now = Date.now(), redemptions = 0 } = {}) {
	if (!offer) return "This offer doesn't exist";
	if (!offer.active) return "This offer has ended";
	if (offer.expiresAt && new Date(offer.expiresAt).getTime() <= now) return "This offer has ended";
	if (offer.maxRedemptions && redemptions >= offer.maxRedemptions) return "This offer has been taken up as many times as it goes";
	return null;
}

// "20% off for 3 months", "$5 off every payment", "A 30-day free trial".
export function describeOffer(offer, formatPrice) {
	const parts = [];
	if (offer.type === "percent" || offer.type === "amount") {
		const amount = offer.type === "percent" ? `${offer.percentOff}%` : formatPrice(offer.amountOffCents, offer.currency);
		const span =
			offer.duration === "forever" ? " every payment" : offer.duration === "repeating" ? ` for ${offer.durationMonths} ${offer.durationMonths === 1 ? "month" : "months"}` : " the first payment";
		parts.push(`${amount} off${span}`);
	}
	if (offer.trialDays > 0) parts.push(`a ${offer.trialDays}-day free trial`);
	const text = parts.join(", with ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
