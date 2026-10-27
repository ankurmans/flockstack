import { getReaderText } from "@/lib/reader-languages";

export function formatReaderBillingDate(newsletter, value, { long = false } = {}) {
	if (!value) return null;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return null;
	return new Intl.DateTimeFormat(getReaderText(newsletter).language, { year: "numeric", month: long ? "long" : "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function readerBillingSummary(newsletter, subscription) {
	const t = getReaderText(newsletter);
	const membership = subscription.tier?.id && subscription.tier.id !== "paid" && subscription.tier.name ? t("{tier} subscriber", { tier: subscription.tier.name }) : t("Paid subscriber");
	let heading = membership;
	if (subscription.access === "comp") heading = t("{membership}, complimentary access", { membership });
	else if (subscription.access === "gift") heading = t("{membership}, on a gift", { membership });
	else if (subscription.access === "stripe") {
		const phrase = { lifetime: "{membership}, paid once for life", month: "{membership}, billed every month", quarter: "{membership}, billed every 3 months", year: "{membership}, billed every year" }[subscription.interval];
		if (phrase) heading = t(phrase, { membership });
	}
	const date = formatReaderBillingDate(newsletter, subscription.paidUntil);
	const period = (subscription.access === "stripe" && subscription.interval === "lifetime") || !date ? "" : t(subscription.access !== "stripe" ? "Your access runs to {date}." : ["canceled", "past_due"].includes(subscription.status) ? "Access until {date}." : "Your current period runs to {date}.", { date });
	return { heading, detail: [period, t("You read every issue of your tier on the website while you are signed in.")].filter(Boolean).join(" ") };
}

export function readerPledgeSummary(newsletter, pledge) {
	const t = getReaderText(newsletter);
	const notice = t(pledge.tierName ? "You pledged {amount} for the {tier} tier. Nothing is charged yet." : "You pledged {amount}. Nothing is charged yet.", { amount: pledge.amount, tier: pledge.tierName });
	const date = formatReaderBillingDate(newsletter, pledge.chargeAt);
	return [notice, date ? t("Your first charge is on {date}.", { date }) : t("We email you before the first charge.")].join(" ");
}

export function readerReferralSummary(newsletter, referral) {
	const t = getReaderText(newsletter);
	if (!Number.isInteger(referral.count) || referral.count < 0) return "";
	const number = (value) => new Intl.NumberFormat(t.language).format(value);
	const summary = t(referral.count === 1 ? "1 person has signed up through your link." : "{count} people have signed up through your link.", { count: number(referral.count) });
	const next = referral.next;
	const reward = next?.title && Number.isInteger(next.remaining) && next.remaining >= 0 ? t(next.remaining === 1 ? "1 more referral unlocks {reward}." : "{count} more referrals unlock {reward}.", { count: number(next.remaining), reward: next.title }) : "";
	return [summary, reward].filter(Boolean).join(" ");
}
