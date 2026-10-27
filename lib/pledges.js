import "server-only";
import { getReaderText } from "@/lib/reader-languages";
import { formatReaderBillingDate } from "@/lib/reader-billing-copy";
import { scoped } from "@/lib/account-scope";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls, getLinkBaseUrl } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { createPaidToken, readPaidToken } from "@/lib/paid-links";
import { formatPrice } from "@/lib/payments/config";
import { getChargeAccount, getPaymentsState } from "@/lib/payments/connect";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";
import { ensurePaidContact } from "@/lib/payments/subscriptions";
import { isRateLimited } from "@/lib/rate-limit";
import { sendTransactionalEmail } from "@/lib/sending";
import { assertFoundingSpot } from "@/lib/supporters";
import { findTier, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Pledge from "@/models/Pledge";

// A pledge is a card saved on the creator's Stripe account with a SetupIntent (Checkout in setup mode) and a price the reader
// agreed to. Nothing is charged and no paid access is given: that waits for the writer to convert the pledges
// (lib/pledge-conversion.js), which tells every pledger first.
export const NOTICE_DAYS = { default: 7, min: 1, max: 30 };
const PER_IP = { name: "pledge-ip", limit: 10, window: "10 m" };
const OPEN_STATUSES = ["active", "notifying", "scheduled", "charging"];
// What a pledger can still cancel themselves: before the charge is being made.
export const CANCELABLE_STATUSES = ["pending", "active", "notifying", "scheduled"];
const UNAVAILABLE = "Pledges aren't available right now. Try again in a minute.";

export function getPledgeSettings(newsletter) {
	const settings = newsletter?.paidTier?.pledges ?? {};
	return { enabled: Boolean(settings.enabled), noticeDays: settings.noticeDays ?? NOTICE_DAYS.default };
}

// Pledges are for a newsletter that isn't taking payments yet: once the paid tier is open, readers subscribe instead.
export function isPledgeOpen(newsletter) {
	return getPledgeSettings(newsletter).enabled && !newsletter?.paidTier?.enabled;
}

function clean(text) {
	return String(text ?? "").replace(/[[\]()<>]/g, "").trim();
}

export function describePledgeAmount(pledge, newsletter = "en") {
	const t = getReaderText(newsletter);
	return `${formatPrice(pledge.amountCents, pledge.currency, t.language)} ${t(pledge.option === "year" ? "a year" : "a month")}`;
}

export function getPledgeCancelUrl(pledge, newsletter) {
	return `${getLinkBaseUrl(newsletter)}/pledge?token=${createPaidToken("pledge-cancel", { p: String(pledge._id), n: String(newsletter._id) })}`;
}

function formatDay(date, newsletter = "en") {
	return formatReaderBillingDate(newsletter, date, { long: true });
}

// A reader pledges from the subscribe page. Resolves to Stripe's page for the card, or the words to show them. The price
// comes from the tier, never from the form.
export async function startPledge({ newsletterSlug, tierId, option, email, ip }) {
	if (await isRateLimited({ ...PER_IP, key: ip })) return { error: "Too many attempts from your network. Try again in a few minutes." };
	if (!["month", "year"].includes(option)) return { error: "Pick monthly or yearly" };
	const address = normalizeEmail(email ?? "");
	if (!address) return { error: "Enter a valid email" };
	const newsletter = await getArchiveNewsletter(newsletterSlug);
	if (!newsletter) return { error: "This newsletter doesn't take pledges" };
	if (newsletter.paidTier?.enabled) return { error: "Paid subscriptions are open now: subscribe instead" };
	if (!isPledgeOpen(newsletter)) return { error: "This newsletter doesn't take pledges" };
	const tiers = getNewsletterTiers(newsletter);
	const tier = findTier(tiers, tierId || getOfferedTiers(tiers)[0]?.id);
	const amountCents = tier && !tier.archived ? tier.prices[option] : 0;
	if (!amountCents) return { error: "This newsletter doesn't offer that plan" };

	await connectDb();
	const account = await Account.findById(newsletter.accountId).lean();
	if (!getPaymentsState(account).ready) return { error: "Pledges aren't open for this newsletter yet" };
	const [contact, open] = await Promise.all([
		Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, email: address }).select({ tier: 1, paidUntil: 1 }).lean(),
		Pledge.exists({ accountId: newsletter.accountId, newsletterId: newsletter._id, email: address, status: { $in: OPEN_STATUSES } }),
	]);
	if (isPaidContact(contact)) return { error: "You're already a paid subscriber" };
	if (open) return { error: "You've already pledged. The email we sent you has a link to cancel it." };
	try {
		await assertFoundingSpot({ account, newsletter, tier });
		const currency = newsletter.paidTier.currency || "usd";
		const pledge = await Pledge.create({ accountId: newsletter.accountId, newsletterId: newsletter._id, email: address, tierId: tier.id, option, amountCents, currency });
		const stripeAccount = getChargeAccount(account);
		const metadata = { flockstack: "1", kind: "pledge", accountId: String(account._id), newsletterId: String(newsletter._id), pledgeId: String(pledge._id), tierId: tier.id, option };
		const customer = await stripeRequest("/v1/customers", { method: "POST", account: stripeAccount, idempotencyKey: `flockstack-pledge-customer-${pledge._id}`, params: { email: address, metadata } });
		const urls = getArchiveUrls(newsletter);
		const session = await stripeRequest("/v1/checkout/sessions", {
			method: "POST",
			account: stripeAccount,
			idempotencyKey: `flockstack-pledge-session-${pledge._id}`,
			params: {
				mode: "setup",
				customer: customer.id,
				currency,
				payment_method_types: ["card"],
				metadata,
				setup_intent_data: { metadata },
				custom_text: { submit: { message: getReaderText(newsletter)("You won't be charged today. Your card is saved, and charged only after {name} starts taking payments, with an email to you first.", { name: newsletter.name }) } },
				success_url: `${urls.absoluteSubscribe}?pledged=1`,
				cancel_url: urls.absoluteSubscribe,
			},
		});
		await Pledge.updateOne(scoped(account, { _id: pledge._id }), { $set: { stripeSessionId: session.id, stripeCustomerId: customer.id } });
		return { url: session.url };
	} catch (error) {
		if (error?.code === "conflict") return { error: error.message };
		console.error(`[pledges] Starting a pledge for newsletter ${newsletter._id} failed: ${error instanceof StripeError ? error.message : error}`);
		return { error: UNAVAILABLE };
	}
}

function buildConfirmationEmail({ pledge, newsletter, tier, noticeDays }) {
	const t = getReaderText(newsletter);
	const name = clean(newsletter.name);
	return {
		subject: t("You pledged to support {name}", { name }),
		reason: t("You're receiving this because you pledged support for {name}.", { name }),
		markdown: [
			t("Thank you for pledging **{amount}** for the {tier} tier of {name}.", { amount: describePledgeAmount(pledge, newsletter), tier: clean(tier?.name ?? t("paid")), name }),
			t("**You haven't been charged, and nothing is charged now.** Your card is saved with Stripe, and you get the free issues as before. If {name} starts taking payments, we'll email you {days} days before the first charge, and you can cancel before it.", { name, days: noticeDays }),
			`[${t("Cancel your pledge")}](${getPledgeCancelUrl(pledge, newsletter)})`,
		].join("\n\n"),
	};
}

// checkout.session.completed for a pledge: the card was saved. Everything here can run twice.
export async function completePledgeSession({ account, session }) {
	const pledge = await Pledge.findOne(scoped(account, { _id: session.metadata?.pledgeId })).lean();
	if (!pledge) return { ignored: "unknown pledge" };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: pledge.newsletterId })).lean();
	if (!newsletter) return { ignored: "unknown newsletter" };

	let current = pledge;
	if (pledge.status === "pending") {
		const intentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
		const intent = intentId ? await stripeRequest(`/v1/setup_intents/${intentId}`, { account: getChargeAccount(account) }) : null;
		const paymentMethodId = typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id;
		if (intent?.status !== "succeeded" || !paymentMethodId) return { ignored: "the card wasn't saved" };
		const customerId = typeof session.customer === "string" ? session.customer : pledge.stripeCustomerId;
		const contact = await ensurePaidContact({ newsletter, email: pledge.email, source: "pledge" });
		const set = { status: "active", setupIntentId: intentId, paymentMethodId, pledgedAt: new Date(), contactId: contact._id, ...(customerId && { stripeCustomerId: customerId }) };
		const { matchedCount } = await Pledge.updateOne(scoped(account, { _id: pledge._id, status: "pending" }), { $set: set });
		if (matchedCount && customerId && !contact.stripeCustomerId) await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: { stripeCustomerId: customerId } });
		current = { ...pledge, ...set };
	}
	if (!current.confirmationSentAt && current.status === "active") await sendPledgeConfirmation({ account, newsletter, pledge: current });
	return { pledgeId: String(pledge._id), status: current.status };
}

async function sendPledgeConfirmation({ account, newsletter, pledge }) {
	const tier = findTier(getNewsletterTiers(newsletter), pledge.tierId);
	const email = buildConfirmationEmail({ pledge, newsletter, tier, noticeDays: getPledgeSettings(newsletter).noticeDays });
	const result = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: pledge.email, ...email });
	if (result.sent) await Pledge.updateOne(scoped(account, { _id: pledge._id }), { $set: { confirmationSentAt: new Date() } });
	return result;
}

async function detachCard({ account, pledge }) {
	if (!pledge.paymentMethodId) return;
	await stripeRequest(`/v1/payment_methods/${pledge.paymentMethodId}/detach`, { method: "POST", account: getChargeAccount(account) }).catch((error) => {
		console.error(`[pledges] Detaching the card of pledge ${pledge._id} failed:`, error.message);
	});
}

// The pledger's own cancel link. Resolves to { ok } or { error }: invalid, charging (too late) or converted (they pay already).
export async function cancelPledgeByToken(token) {
	const reference = readPaidToken("pledge-cancel", token);
	if (!reference) return { error: "invalid" };
	await connectDb();
	const pledge = await Pledge.findOne({ _id: reference.p, newsletterId: reference.n }).setOptions({ crossAccount: true }).lean();
	if (!pledge) return { error: "invalid" };
	const newsletter = await Newsletter.findOne({ accountId: pledge.accountId, _id: pledge.newsletterId }).lean();
	const info = { newsletterName: newsletter?.name ?? "this newsletter" };
	if (pledge.status === "canceled") return { ok: true, ...info };
	if (pledge.status === "converted") return { error: "converted", ...info };
	if (pledge.status === "charging" || !CANCELABLE_STATUSES.includes(pledge.status)) return { error: "too-late", ...info };
	const { matchedCount } = await Pledge.updateOne(scoped(pledge.accountId, { _id: pledge._id, status: { $in: CANCELABLE_STATUSES } }), { $set: { status: "canceled", canceledAt: new Date() } });
	if (!matchedCount) return { error: "too-late", ...info };
	const account = await Account.findById(pledge.accountId).lean();
	if (account) await detachCard({ account, pledge });
	return { ok: true, ...info };
}

// The writer cancels a pledge: the same as the pledger's link, from the dashboard or the API.
export async function cancelPledgeForOwner(account, pledge) {
	if (!CANCELABLE_STATUSES.includes(pledge.status)) return false;
	const { matchedCount } = await Pledge.updateOne(scoped(account, { _id: pledge._id, status: { $in: CANCELABLE_STATUSES } }), { $set: { status: "canceled", canceledAt: new Date() } });
	if (matchedCount) await detachCard({ account, pledge });
	return Boolean(matchedCount);
}

// What is pledged: per tier, how many pledges and how much, monthly and yearly pledges apart and as a monthly total.
export async function getPledgeReport(account, newsletter) {
	const pledges = await Pledge.find(scoped(account, { newsletterId: newsletter._id, status: { $in: OPEN_STATUSES } }))
		.select({ tierId: 1, option: 1, amountCents: 1, currency: 1 })
		.lean();
	const tiers = getNewsletterTiers(newsletter);
	const byTier = new Map(tiers.map((tier) => [tier.id, { tierId: tier.id, name: tier.name, pledges: 0, monthlyCents: 0, yearlyCents: 0 }]));
	for (const pledge of pledges) {
		const row = byTier.get(pledge.tierId) ?? { tierId: pledge.tierId, name: pledge.tierId, pledges: 0, monthlyCents: 0, yearlyCents: 0 };
		byTier.set(pledge.tierId, row);
		row.pledges++;
		row[pledge.option === "year" ? "yearlyCents" : "monthlyCents"] += pledge.amountCents;
	}
	const rows = [...byTier.values()].map((row) => ({ ...row, perMonthCents: row.monthlyCents + Math.round(row.yearlyCents / 12) }));
	return {
		pledges: pledges.length,
		perMonthCents: rows.reduce((sum, row) => sum + row.perMonthCents, 0),
		currency: newsletter.paidTier?.currency ?? "usd",
		tiers: rows,
	};
}

export { clean, formatDay };
