import "server-only";
import { codedError } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { assertPaymentsReady, getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { normalizeEmail } from "@/lib/validation";

// Every sale is a Stripe Checkout Session on the creator's own Stripe account (a direct charge): the buyer pays them, their
// payout and fees are Stripe's, and FlockStack sets no application fee, ever (lib/payments/stripe-api.js refuses one).
// metadata.flockstack marks what FlockStack made, so the webhook ignores the rest of the creator's Stripe account.
const DESCRIPTION_LIMIT = 500;

function baseMetadata({ account, newsletter, kind }) {
	return { flockstack: "1", kind, accountId: String(account._id), newsletterId: String(newsletter._id) };
}

export async function createProductCheckout({ account, newsletter, product, email, addToList = false }) {
	assertPaymentsReady(account);
	if (product.status !== "active" || !product.file?.key) throw codedError({ code: "conflict", message: "This product isn't for sale" });
	const urls = getArchiveUrls(newsletter);
	const metadata = { ...baseMetadata({ account, newsletter, kind: "product" }), productId: String(product._id), addToList: addToList ? "1" : "0" };
	const buyerEmail = normalizeEmail(email ?? "");
	const session = await stripeRequest("/v1/checkout/sessions", {
		method: "POST",
		account: getChargeAccount(account),
		params: {
			mode: "payment",
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: product.currency,
						unit_amount: product.priceCents,
						product_data: {
							name: product.title,
							...(product.description && { description: product.description.slice(0, DESCRIPTION_LIMIT) }),
							...(product.imageUrl?.startsWith("https://") && { images: [product.imageUrl] }),
						},
					},
				},
			],
			metadata,
			payment_intent_data: { metadata, description: `${product.title} (${newsletter.name})` },
			...(buyerEmail && { customer_email: buyerEmail }),
			custom_text: { submit: { message: "The download link comes to your email as soon as you've paid." } },
			success_url: `${urls.absoluteProduct(product.slug)}?paid=1`,
			cancel_url: urls.absoluteProduct(product.slug),
		},
	});
	return { id: session.id, url: session.url };
}
