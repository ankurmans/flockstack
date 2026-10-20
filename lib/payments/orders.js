import "server-only";
import { scoped } from "@/lib/account-scope";
import { sendAlert } from "@/lib/alerts";
import { getLinkBaseUrl } from "@/lib/archive-hosts";
import { isSendingEnabled } from "@/lib/config";
import { getSignupProblem, upsertContact } from "@/lib/contacts";
import { DOWNLOAD_LINK_DAYS, MAX_DOWNLOADS_PER_ORDER, createDownloadToken } from "@/lib/download-link";
import { formatPrice } from "@/lib/payments/config";
import { queueConfirmationEmail, queueWelcomeEmail, sendTransactionalEmail } from "@/lib/sending";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { enrollOnProductBought } from "@/lib/automation-triggers";
import { emitOrderPaid } from "@/lib/webhooks";
import Buyer from "@/models/Buyer";
import Newsletter from "@/models/Newsletter";
import Order from "@/models/Order";
import Product from "@/models/Product";

// A second delivery of the same event while the first is still sending its email waits this long before it tries too.
const EMAIL_CLAIM_MS = 2 * 60_000;

function clean(text) {
	return String(text ?? "").replace(/[[\]()<>]/g, "").trim();
}

export async function getDownloadUrl({ order, newsletter }) {
	const token = await createDownloadToken({ orderId: order._id, version: order.tokenVersion ?? 1 });
	return `${getLinkBaseUrl(newsletter)}/api/shop/download?token=${token}`;
}

function buildOrderEmail({ order, newsletter, url }) {
	const title = clean(order.productTitle);
	return {
		subject: `Your download: ${title}`,
		reason: `You're receiving this because you bought ${title} from ${newsletter.name}.`,
		markdown: [
			`Thanks for your order of **${title}** (${formatPrice(order.amountCents, order.currency)}).`,
			`[Download ${title}](${url})`,
			`The link works for ${DOWNLOAD_LINK_DAYS} days and up to ${MAX_DOWNLOADS_PER_ORDER} downloads. If it stops working, reply to this email and we'll send a new one.`,
		].join("\n\n"),
	};
}

// One email per order, however many times Stripe delivers the event: the claim keeps two deliveries from both sending, and
// a delivery that finds it sent does nothing. A provider that is down throws, so Stripe delivers the event again.
export async function sendDownloadEmail({ account, newsletter, order }) {
	if (order.emailStatus === "sent") return { sent: false, alreadySent: true };
	const claimedBefore = new Date(Date.now() - EMAIL_CLAIM_MS);
	const { modifiedCount } = await Order.updateOne(
		scoped(account, { _id: order._id, emailStatus: { $ne: "sent" }, $or: [{ emailClaimedAt: null }, { emailClaimedAt: { $lt: claimedBefore } }] }),
		{ $set: { emailClaimedAt: new Date() } }
	);
	if (!modifiedCount) return { sent: false, claimed: true };

	let result;
	try {
		const email = buildOrderEmail({ order, newsletter, url: await getDownloadUrl({ order, newsletter }) });
		result = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: order.buyerEmail, ...email });
	} catch (error) {
		await Order.updateOne(scoped(account, { _id: order._id }), { $unset: { emailClaimedAt: 1 } });
		throw error;
	}
	if (result.sent) {
		await Order.updateOne(scoped(account, { _id: order._id }), { $set: { emailStatus: "sent", emailSentAt: new Date() }, $unset: { emailClaimedAt: 1, emailError: 1 } });
		return result;
	}
	const emailStatus = result.reason === "suppressed" ? "suppressed" : "failed";
	await Order.updateOne(scoped(account, { _id: order._id }), { $set: { emailStatus, emailError: result.reason }, $unset: { emailClaimedAt: 1 } });
	await sendAlert({
		accountId: account._id,
		key: `order-email:${order._id}`,
		title: "A buyer's download email didn't go out",
		detail: `${order.buyerEmail} bought ${order.productTitle}, but the email with the download link wasn't sent: ${result.reason}.`,
		action: "Fix what stopped it, then resend the link from the order.",
		path: "/orders",
	});
	return result;
}

// The buyer ticked the box: they join the newsletter's list the way a signup form would, so a newsletter that confirms
// signups still asks them to confirm.
async function joinList({ account, newsletter, order }) {
	if (order.listConsent?.at) return;
	if (await getSignupProblem(order.buyerEmail)) return;
	const { contact, created } = await upsertContact({ newsletter, email: order.buyerEmail, source: "shop", resubscribe: true });
	await Order.updateOne(scoped(account, { _id: order._id }), { $set: { "listConsent.at": new Date(), "listConsent.contactId": contact._id } });
	if (!isSendingEnabled()) return;
	const isPending = contact.status === "pending";
	if (!isPending && !(created && contact.status === "active")) return;
	const queue = isPending ? queueConfirmationEmail : queueWelcomeEmail;
	await queue({ newsletter, contact }).catch((error) => console.error(`[orders] The signup email for ${contact._id} failed:`, error.message));
}

async function recordBuyer({ account, order }) {
	await Buyer.updateOne(
		scoped(account, { email: order.buyerEmail }),
		{
			$setOnInsert: { firstOrderAt: order.paidAt },
			$set: { lastOrderAt: order.paidAt, ...(order.buyerName && { name: order.buyerName }) },
			$inc: { orderCount: 1 },
		},
		{ upsert: true }
	);
}

// checkout.session.completed (and the async payment succeeding) for a product. Everything here can run twice: the order is
// keyed by its Checkout Session, the buyer is counted once, the list is joined once and the email goes out once.
export async function fulfillProductOrder({ account, session }) {
	if (session.payment_status !== "paid") return { ignored: "not paid yet" };
	const productId = session.metadata?.productId;
	const product = isObjectIdString(productId ?? "") ? await Product.findOne(scoped(account, { _id: productId })).lean() : null;
	const email = normalizeEmail(session.customer_details?.email ?? session.customer_email ?? "");
	if (!product || !email) {
		console.error(`[orders] Session ${session.id} paid, but ${product ? "has no buyer email" : "its product is gone"}`);
		return { ignored: product ? "no buyer email" : "unknown product" };
	}
	const newsletter = await Newsletter.findOne(scoped(account, { _id: product.newsletterId })).lean();
	if (!newsletter) return { ignored: "unknown newsletter" };

	const paidAt = new Date();
	const result = await Order.findOneAndUpdate(
		scoped(account, { stripeSessionId: session.id }),
		{
			$setOnInsert: {
				newsletterId: product.newsletterId,
				productId: product._id,
				productTitle: product.title,
				stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? undefined),
				buyerEmail: email,
				buyerName: session.customer_details?.name ?? undefined,
				amountCents: session.amount_total ?? product.priceCents,
				currency: String(session.currency ?? product.currency).toLowerCase(),
				paidAt,
				status: "paid",
				amountRefundedCents: 0,
				tokenVersion: 1,
				downloadCount: 0,
				emailStatus: "pending",
			},
		},
		{ upsert: true, returnDocument: "after", includeResultMetadata: true }
	).lean();
	const order = result.value;
	if (!result.lastErrorObject?.updatedExisting) {
		await recordBuyer({ account, order });
		await emitOrderPaid(order);
	}

	if (session.metadata.addToList === "1") await joinList({ account, newsletter, order });
	if (!result.lastErrorObject?.updatedExisting) await enrollOnProductBought(order);
	// A refund that landed before this repeat must not get a new link.
	if (order.status === "paid") await sendDownloadEmail({ account, newsletter, order });
	return { orderId: String(order._id), created: !result.lastErrorObject?.updatedExisting };
}

// A refund in Stripe (the creator's dashboard): a full one stops the download link, a partial one is only recorded.
async function handleRefund({ account, object }) {
	const order = await Order.findOne(scoped(account, { stripePaymentIntentId: object.payment_intent })).lean();
	if (!order) return { ignored: "no order for this charge" };
	const isFull = object.refunded === true || (object.amount > 0 && object.amount_refunded >= object.amount);
	const now = new Date();
	await Order.updateOne(scoped(account, { _id: order._id }), {
		$set: { amountRefundedCents: object.amount_refunded ?? 0, ...(isFull && { status: "refunded", revokedAt: order.revokedAt ?? now, refundedAt: order.refundedAt ?? now }) },
	});
	return { orderId: String(order._id), revoked: isFull };
}

// A chargeback: the bank took the money back, so the link stops too.
async function handleDispute({ account, object }) {
	const order = await Order.findOne(scoped(account, { stripePaymentIntentId: object.payment_intent })).lean();
	if (!order) return { ignored: "no order for this charge" };
	if (order.status === "paid") await Order.updateOne(scoped(account, { _id: order._id }), { $set: { status: "disputed", revokedAt: new Date() } });
	return { orderId: String(order._id), revoked: true };
}

export const orderHandlers = {
	"charge.refunded": handleRefund,
	"charge.dispute.created": handleDispute,
};

// Where a charge or a dispute on a self-hosted server comes from, as its events carry no metadata.
export async function findOrderAccountId(object) {
	if (typeof object.payment_intent !== "string") return null;
	const order = await Order.findOne({ stripePaymentIntentId: object.payment_intent }).select({ accountId: 1 }).setOptions({ crossAccount: true }).lean();
	return order?.accountId ?? null;
}

// Sends the link again, with a new one: the old link stops working. For a buyer who lost the email or let it expire.
export async function resendDownloadEmail({ account, order }) {
	const newsletter = await Newsletter.findOne(scoped(account, { _id: order.newsletterId })).lean();
	if (!newsletter) return { sent: false, reason: "Newsletter not found" };
	await Order.updateOne(scoped(account, { _id: order._id }), { $inc: { tokenVersion: 1 }, $set: { emailStatus: "pending" }, $unset: { emailClaimedAt: 1, emailError: 1 } });
	const fresh = await Order.findOne(scoped(account, { _id: order._id })).lean();
	return sendDownloadEmail({ account, newsletter, order: fresh });
}
