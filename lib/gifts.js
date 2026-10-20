import "server-only";
import { scoped } from "@/lib/account-scope";
import { sendAlert } from "@/lib/alerts";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls, getLinkBaseUrl } from "@/lib/archive-hosts";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { GIFT_REDEEM_MONTHS, MAX_DELIVERY_DAYS, MAX_MESSAGE_LENGTH, addMonths, getGiftExpiry, getGiftPrice, getGiftState, readDeliveryDay } from "@/lib/gift-rules";
import { grantAccess, revokeGrant } from "@/lib/grant-access";
import { getActiveGrant, isGrantDriving } from "@/lib/grants";
import { createPaidToken, readPaidToken } from "@/lib/paid-links";
import { formatPrice } from "@/lib/payments/config";
import { getChargeAccount, getPaymentsState } from "@/lib/payments/connect";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";
import { ensurePaidContact } from "@/lib/payments/subscriptions";
import { isRateLimited } from "@/lib/rate-limit";
import { publishJob, sendTransactionalEmail } from "@/lib/sending";
import { assertFoundingSpot } from "@/lib/supporters";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Gift from "@/models/Gift";
import Newsletter from "@/models/Newsletter";

// A gift is a one-time Checkout Session on the creator's account. When it is paid, the buyer gets a receipt with a page that
// lists their gifts, and on the delivery date the recipient gets an email with the buyer's message and a link. Redeeming it
// gives paid access for its months from that day, as a gift (lib/grant-access.js), apart from any Stripe subscription.
const PER_IP = { name: "gift-ip", limit: 10, window: "10 m" };
const MAX_WAIT_MS = 6 * 86_400_000;
const CLAIM_MS = 5 * 60_000;
const UNAVAILABLE = "Gifts aren't available right now. Try again in a minute.";

export function areGiftsOpen(newsletter) {
	return Boolean(newsletter?.paidTier?.enabled && newsletter.paidTier.gifts?.enabled);
}

function clean(text) {
	return String(text ?? "").replace(/[[\]()<>]/g, "").trim();
}

// The buyer's words go into an email from the newsletter, so they come out as plain text: no links, no markup.
export function cleanMessage(text) {
	return String(text ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/(?:https?:\/\/|www\.)\S+/gi, "")
		.replace(/[[\]()<>*_`#|\\]/g, "")
		.replace(/[^\S\n]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, MAX_MESSAGE_LENGTH);
}

function formatDay(date) {
	return new Date(date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function getGiftRedeemUrl(gift, newsletter) {
	return `${getLinkBaseUrl(newsletter)}/gift?token=${createPaidToken("gift-redeem", { g: String(gift._id), n: String(newsletter._id) })}`;
}

export function getBuyerGiftsUrl(gift, newsletter) {
	return `${getLinkBaseUrl(newsletter)}/gifts?token=${createPaidToken("gift-buyer", { e: gift.buyerEmail, n: String(newsletter._id) })}`;
}

// A reader buys a gift from the newsletter's gift page. Resolves to Stripe's Checkout URL, or the words to show them.
export async function startGiftPurchase({ newsletterSlug, tierId, months, recipientEmail, buyerEmail, buyerName, message, deliverOn, ip }) {
	if (await isRateLimited({ ...PER_IP, key: ip })) return { error: "Too many attempts from your network. Try again in a few minutes." };
	const recipient = normalizeEmail(recipientEmail ?? "");
	const buyer = normalizeEmail(buyerEmail ?? "");
	if (!recipient) return { error: "Enter a valid email for the person getting the gift" };
	if (!buyer) return { error: "Enter your own email, for the receipt" };
	const day = readDeliveryDay(deliverOn) ?? readDeliveryDay(new Date().toISOString().slice(0, 10));
	const today = readDeliveryDay(new Date().toISOString().slice(0, 10));
	if (day < today) return { error: "Pick today or a day to come" };
	if (day.getTime() - today.getTime() > MAX_DELIVERY_DAYS * 86_400_000) return { error: `Pick a day within ${MAX_DELIVERY_DAYS} days` };
	const newsletter = await getArchiveNewsletter(newsletterSlug);
	if (!areGiftsOpen(newsletter)) return { error: "This newsletter doesn't sell gifts" };
	const tiers = getNewsletterTiers(newsletter);
	const tier = findTier(tiers, tierId || tiers.find((candidate) => !candidate.archived)?.id);
	const wanted = Number(months);
	const amountCents = tier && !tier.archived ? getGiftPrice(tier, wanted) : 0;
	if (!amountCents || ![1, 3, 6, 12].includes(wanted)) return { error: "This newsletter doesn't offer that gift" };

	await connectDb();
	const account = await Account.findById(newsletter.accountId).lean();
	if (!getPaymentsState(account).ready) return { error: "Gifts aren't open for this newsletter yet" };
	try {
		await assertFoundingSpot({ account, newsletter, tier });
		const currency = newsletter.paidTier.currency || "usd";
		const gift = await Gift.create({
			accountId: newsletter.accountId,
			newsletterId: newsletter._id,
			tierId: tier.id,
			months: wanted,
			amountCents,
			currency,
			buyerEmail: buyer,
			...(clean(buyerName) && { buyerName: clean(buyerName).slice(0, 60) }),
			recipientEmail: recipient,
			...(cleanMessage(message) && { message: cleanMessage(message) }),
			deliverOn: day,
		});
		const urls = getArchiveUrls(newsletter);
		const metadata = { flockstack: "1", kind: "gift", accountId: String(account._id), newsletterId: String(newsletter._id), giftId: String(gift._id), tierId: tier.id, months: String(wanted) };
		const session = await stripeRequest("/v1/checkout/sessions", {
			method: "POST",
			account: getChargeAccount(account),
			idempotencyKey: `flockstack-gift-session-${gift._id}`,
			params: {
				mode: "payment",
				line_items: [
					{
						quantity: 1,
						price_data: {
							currency,
							unit_amount: amountCents,
							product_data: { name: `Gift: ${wanted} ${wanted === 1 ? "month" : "months"} of ${newsletter.name}, ${tier.name}`.slice(0, 250) },
						},
					},
				],
				metadata,
				payment_intent_data: { metadata, description: `Gift subscription (${newsletter.name})` },
				customer_email: buyer,
				custom_text: { submit: { message: `${recipient} gets an email on ${formatDay(day)} with a link to redeem it. They can redeem it for ${GIFT_REDEEM_MONTHS} months; their ${wanted} ${wanted === 1 ? "month starts" : "months start"} the day they do.` } },
				success_url: `${urls.absoluteSubscribe}?gift=1`,
				cancel_url: urls.absoluteGive,
			},
		});
		await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { stripeSessionId: session.id } });
		return { url: session.url };
	} catch (error) {
		if (error?.code === "conflict") return { error: error.message };
		console.error(`[gifts] Starting a gift for newsletter ${newsletter._id} failed: ${error instanceof StripeError ? error.message : error}`);
		return { error: UNAVAILABLE };
	}
}

function publishDelivery(gift, notBeforeMs) {
	return publishJob({
		url: `${getAppUrl()}/api/jobs/deliver-gift`,
		body: { accountId: String(gift.accountId), giftId: String(gift._id) },
		...(notBeforeMs > Date.now() && { notBefore: Math.floor(notBeforeMs / 1000) }),
	});
}

async function sendBuyerReceipt({ account, newsletter, gift }) {
	const tier = findTier(getNewsletterTiers(newsletter), gift.tierId);
	const result = await sendTransactionalEmail({
		accountId: account._id,
		newsletterId: newsletter._id,
		to: gift.buyerEmail,
		subject: `Your gift for ${clean(gift.recipientEmail)} is paid`,
		reason: `You're receiving this because you bought a gift subscription to ${clean(newsletter.name)}.`,
		markdown: [
			`Thank you for your gift: **${gift.months} ${gift.months === 1 ? "month" : "months"}** of the ${clean(tier?.name ?? "paid")} tier of ${clean(newsletter.name)} (${formatPrice(gift.amountCents, gift.currency)}).`,
			`${clean(gift.recipientEmail)} gets an email with your message on **${formatDay(gift.deliverOn)}**, with a link to redeem it. Their months start the day they redeem. A gift can be redeemed until **${formatDay(gift.expiresAt)}**, and expires after that.`,
			`[See your gifts and whether they were redeemed](${getBuyerGiftsUrl(gift, newsletter)})`,
		].join("\n\n"),
	});
	if (result.sent) await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { receiptSentAt: new Date() } });
	return result;
}

// checkout.session.completed for a gift. Everything here can run twice.
export async function completeGiftSession({ account, session }) {
	if (session.payment_status !== "paid") return { ignored: "not paid yet" };
	const gift = await Gift.findOne(scoped(account, { _id: session.metadata?.giftId })).lean();
	if (!gift) return { ignored: "unknown gift" };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: gift.newsletterId })).lean();
	if (!newsletter) return { ignored: "unknown newsletter" };

	let current = gift;
	if (gift.status === "awaiting_payment") {
		const paidAt = new Date();
		const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? undefined);
		const set = { status: "paid", paidAt, expiresAt: getGiftExpiry(paidAt), ...(paymentIntentId && { paymentIntentId }) };
		const { matchedCount } = await Gift.updateOne(scoped(account, { _id: gift._id, status: "awaiting_payment" }), { $set: set });
		current = { ...gift, ...set };
		if (matchedCount) await publishDelivery(current, new Date(gift.deliverOn).getTime()).catch((error) => console.error(`[gifts] Scheduling gift ${gift._id} failed (the hourly check delivers it):`, error.message));
	}
	if (!current.receiptSentAt && ["paid", "sent", "redeemed"].includes(current.status)) await sendBuyerReceipt({ account, newsletter, gift: current });
	return { giftId: String(gift._id), status: current.status };
}

function buildGiftEmail({ gift, newsletter, tier }) {
	const name = clean(newsletter.name);
	const from = clean(gift.buyerName) || "Someone";
	const lines = [`${from} gave you **${gift.months} ${gift.months === 1 ? "month" : "months"}** of the ${clean(tier?.name ?? "paid")} tier of ${name}: every issue, the paid ones included.`];
	if (gift.message) lines.push(gift.message.split("\n").map((line) => `> ${line}`).join("\n"));
	lines.push(`[Redeem your gift](${getGiftRedeemUrl(gift, newsletter)})`);
	lines.push(`Your ${gift.months} ${gift.months === 1 ? "month starts" : "months start"} the day you redeem it. The gift can be redeemed until **${formatDay(gift.expiresAt)}**, and expires after that.`);
	return {
		subject: `${from} gave you ${gift.months} ${gift.months === 1 ? "month" : "months"} of ${name}`.slice(0, 200),
		reason: `You're receiving this once because ${from === "Someone" ? "someone" : from} bought you a gift subscription to ${name}. You aren't subscribed until you redeem it.`,
		markdown: lines.join("\n\n"),
	};
}

// Sends the gift's email to its recipient: once, however many times the delivery runs. A recipient the email can't reach
// leaves the gift as it is, with the reason, for the writer to resend to another address.
export async function deliverGift({ gift, newsletter }) {
	const accountId = gift.accountId;
	const claimedBefore = new Date(Date.now() - CLAIM_MS);
	const claim = await Gift.updateOne(scoped(accountId, { _id: gift._id, status: "paid", $or: [{ deliveryClaimedAt: null }, { deliveryClaimedAt: { $lt: claimedBefore } }] }), { $set: { deliveryClaimedAt: new Date() } });
	if (!claim.matchedCount) return { skipped: "already delivered or being delivered" };
	let result;
	try {
		result = await sendTransactionalEmail({ accountId, newsletterId: newsletter._id, to: gift.recipientEmail, ...buildGiftEmail({ gift, newsletter, tier: findTier(getNewsletterTiers(newsletter), gift.tierId) }) });
	} catch (error) {
		await Gift.updateOne(scoped(accountId, { _id: gift._id }), { $unset: { deliveryClaimedAt: 1 } });
		throw error;
	}
	if (result.sent) {
		await Gift.updateOne(scoped(accountId, { _id: gift._id }), { $set: { status: "sent", sentAt: new Date() }, $unset: { deliveryClaimedAt: 1, deliveryError: 1 } });
		return { sent: true };
	}
	await Gift.updateOne(scoped(accountId, { _id: gift._id }), { $set: { deliveryError: String(result.reason).slice(0, 200) }, $unset: { deliveryClaimedAt: 1 } });
	await sendAlert({
		accountId,
		key: `gift-email:${gift._id}`,
		title: "A gift's email didn't go out",
		detail: `The gift email for ${gift.recipientEmail} wasn't sent: ${result.reason}.`,
		action: "Resend the gift to another address (resend_gift), or refund it in Stripe.",
		path: "/payments",
	});
	return { sent: false, reason: result.reason };
}

// The delivery date's job: waits for the day (a long wait is several jobs), then delivers.
export async function runGiftDeliveryStep({ accountId, giftId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(giftId))) return { skipped: "invalid job" };
	await connectDb();
	const gift = await Gift.findOne(scoped(accountId, { _id: giftId })).lean();
	if (!gift || gift.status !== "paid") return { skipped: gift?.status ?? "not found" };
	const wait = new Date(gift.deliverOn).getTime() - Date.now();
	if (wait > 0) {
		await publishDelivery(gift, Date.now() + Math.min(wait, MAX_WAIT_MS));
		return { waiting: true };
	}
	const newsletter = await Newsletter.findOne(scoped(accountId, { _id: gift.newsletterId })).lean();
	return newsletter ? deliverGift({ gift, newsletter }) : { skipped: "unknown newsletter" };
}

// The hourly check: gifts due that no job delivered, and gifts nobody redeemed in time.
export async function deliverDueGifts({ now = new Date(), limit = 100 } = {}) {
	await connectDb();
	const due = await Gift.find({ status: "paid", deliverOn: { $lte: now }, deliveryError: null }).setOptions({ crossAccount: true }).limit(limit).lean();
	let sent = 0;
	for (const gift of due) {
		const newsletter = await Newsletter.findOne(scoped(gift.accountId, { _id: gift.newsletterId })).lean();
		if (!newsletter) continue;
		try {
			if ((await deliverGift({ gift, newsletter })).sent) sent++;
		} catch (error) {
			console.error(`[gifts] Delivering gift ${gift._id} failed:`, error.message);
		}
	}
	return { sent };
}

export async function expireGifts({ now = new Date() } = {}) {
	await connectDb();
	const { modifiedCount } = await Gift.updateMany({ status: { $in: ["paid", "sent"] }, expiresAt: { $lte: now } }, { $set: { status: "expired" } }, { crossAccount: true });
	return { expired: modifiedCount ?? 0 };
}

async function findGiftByToken(token) {
	const reference = readPaidToken("gift-redeem", token);
	if (!reference) return null;
	const gift = await Gift.findOne({ _id: reference.g, newsletterId: reference.n }).setOptions({ crossAccount: true }).lean();
	if (!gift || gift.status === "awaiting_payment") return null;
	const newsletter = await Newsletter.findOne({ accountId: gift.accountId, _id: gift.newsletterId }).lean();
	return newsletter ? { gift, newsletter } : null;
}

// What the redeem page shows for a link: the gift in words, and whether it can be redeemed.
export async function readGiftForPage(token) {
	await connectDb();
	const found = await findGiftByToken(token);
	if (!found) return null;
	const { gift, newsletter } = found;
	const tier = findTier(getNewsletterTiers(newsletter), gift.tierId);
	return {
		newsletterName: newsletter.name,
		tierName: tier?.name ?? "paid",
		months: gift.months,
		from: gift.buyerName ?? null,
		message: gift.message ?? null,
		state: getGiftState(gift),
		expiresAt: gift.expiresAt ? new Date(gift.expiresAt).toISOString() : null,
		archiveUrl: newsletter.archiveEnabled ? getArchiveUrls(newsletter).siteIndex : null,
	};
}

// The recipient redeems: paid access for the gift's months from now (or from when other paid access ends, so none of it is
// wasted), as a gift. A second click does nothing. Resolves to { ok, until } or { error }.
export async function redeemGift(token) {
	await connectDb();
	const found = await findGiftByToken(token);
	if (!found) return { error: "invalid" };
	const { gift, newsletter } = found;
	const state = getGiftState(gift);
	if (state === "redeemed") return { ok: true, already: true, until: gift.accessUntil ? new Date(gift.accessUntil).toISOString() : null, newsletterName: newsletter.name };
	if (state !== "paid" && state !== "sent") return { error: state, newsletterName: newsletter.name };

	const account = await Account.findById(gift.accountId).lean();
	const claim = await Gift.updateOne(scoped(account, { _id: gift._id, status: { $in: ["paid", "sent"] } }), { $set: { status: "redeemed", redeemedAt: new Date() } });
	if (!claim.matchedCount) return { error: "redeemed", newsletterName: newsletter.name };
	try {
		const contact = await ensurePaidContact({ newsletter, email: gift.recipientEmail, source: "gift" });
		const isSubscriptionPaying = isPaidContact(contact) && ["active", "trialing"].includes(contact.subscriptionStatus) && !isGrantDriving(contact);
		const start = Math.max(Date.now(), getActiveGrant(contact) ? new Date(contact.grant.until).getTime() : 0, isSubscriptionPaying ? new Date(contact.paidUntil).getTime() : 0);
		const until = addMonths(new Date(start), gift.months);
		const updated = await grantAccess({ account, newsletter, contact, tierId: gift.tierId, until, kind: "gift", giftId: gift._id });
		await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { contactId: updated._id, accessUntil: until } });
		return { ok: true, until: until.toISOString(), newsletterName: newsletter.name };
	} catch (error) {
		await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { status: gift.status } });
		throw error;
	}
}

// The buyer's page: the gifts bought with their email from this newsletter.
export async function readBuyerGifts(token) {
	const reference = readPaidToken("gift-buyer", token);
	if (!reference) return null;
	await connectDb();
	const newsletter = await Newsletter.findOne({ _id: reference.n }).setOptions({ crossAccount: true }).lean();
	if (!newsletter) return null;
	const gifts = await Gift.find(scoped(newsletter.accountId, { newsletterId: newsletter._id, buyerEmail: reference.e, status: { $ne: "awaiting_payment" } }))
		.sort({ createdAt: -1, _id: -1 })
		.limit(100)
		.lean();
	const tiers = getNewsletterTiers(newsletter);
	return {
		newsletterName: newsletter.name,
		giveUrl: newsletter.archiveEnabled && areGiftsOpen(newsletter) ? getArchiveUrls(newsletter).give : null,
		gifts: gifts.map((gift) => {
			const state = getGiftState(gift);
			return {
				id: String(gift._id),
				recipientEmail: gift.recipientEmail,
				tierName: findTier(tiers, gift.tierId)?.name ?? "paid",
				months: gift.months,
				amount: formatPrice(gift.amountCents, gift.currency),
				state,
				deliverOn: new Date(gift.deliverOn).toISOString(),
				redeemedAt: gift.redeemedAt ? new Date(gift.redeemedAt).toISOString() : null,
				expiresAt: gift.expiresAt ? new Date(gift.expiresAt).toISOString() : null,
				deliveryError: gift.deliveryError ?? null,
				redeemUrl: state === "paid" || state === "sent" ? getGiftRedeemUrl(gift, newsletter) : null,
			};
		}),
	};
}

// A full refund in Stripe ends the gift: unredeemed, it can't be redeemed; redeemed, its access is taken back.
export async function handleGiftRefund({ account, object }) {
	const isFull = object.refunded === true || (object.amount > 0 && object.amount_refunded >= object.amount);
	const gift = typeof object.payment_intent === "string" ? await Gift.findOne(scoped(account, { paymentIntentId: object.payment_intent })).lean() : null;
	if (!gift) return { ignored: "no gift for this charge" };
	if (!isFull) return { ignored: "a partial refund" };
	await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { status: "refunded" } });
	if (gift.status === "redeemed" && gift.contactId) {
		const contact = await Contact.findOne(scoped(account, { _id: gift.contactId })).lean();
		const newsletter = await Newsletter.findOne(scoped(account, { _id: gift.newsletterId })).lean();
		if (contact?.grant?.giftId === String(gift._id)) {
			await revokeGrant({ account, newsletter, contact });
		}
	}
	return { giftId: String(gift._id), refunded: true };
}

export async function findGiftAccountId(object) {
	if (typeof object.payment_intent !== "string") return null;
	const gift = await Gift.findOne({ paymentIntentId: object.payment_intent }).select({ accountId: 1 }).setOptions({ crossAccount: true }).lean();
	return gift?.accountId ?? null;
}

// The writer sends the email again, to the same address or a new one.
export async function resendGift({ account, gift, recipientEmail }) {
	const newsletter = await Newsletter.findOne(scoped(account, { _id: gift.newsletterId })).lean();
	if (!newsletter) return { sent: false, reason: "Newsletter not found" };
	const address = recipientEmail ? normalizeEmail(recipientEmail) : gift.recipientEmail;
	if (!address) return { sent: false, reason: "The email address is invalid" };
	await Gift.updateOne(scoped(account, { _id: gift._id }), { $set: { recipientEmail: address, status: "paid" }, $unset: { deliveryError: 1, deliveryClaimedAt: 1 } });
	return deliverGift({ gift: { ...gift, recipientEmail: address, status: "paid" }, newsletter });
}

