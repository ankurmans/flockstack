import "server-only";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { connectDb } from "@/lib/db";
import { createProductCheckout } from "@/lib/payments/checkout";
import { getPaymentsState } from "@/lib/payments/connect";
import { StripeError } from "@/lib/payments/stripe-api";
import { PRODUCT_SLUG_PATTERN } from "@/lib/products";
import { isRateLimited } from "@/lib/rate-limit";
import Account from "@/models/Account";
import Product from "@/models/Product";

const PER_IP = { name: "checkout-ip", limit: 20, window: "10 m" };
const UNAVAILABLE = "Checkout isn't available right now. Try again in a minute.";

// A reader starts a purchase from the newsletter's shop: the product page's buy form. Resolves to the Stripe Checkout URL, or
// the words to show them. The product, its price and its account come from the database, never from the form.
export async function startProductPurchase({ newsletterSlug, productSlug, email, addToList, ip }) {
	if (await isRateLimited({ ...PER_IP, key: ip })) return { error: "Too many purchases started from your network. Try again in a few minutes." };
	if (!PRODUCT_SLUG_PATTERN.test(productSlug ?? "")) return { error: "This product isn't for sale" };
	const newsletter = await getArchiveNewsletter(newsletterSlug);
	if (!newsletter) return { error: "This shop isn't open" };

	await connectDb();
	const [account, product] = await Promise.all([
		Account.findById(newsletter.accountId).lean(),
		Product.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, slug: productSlug, status: "active" }).lean(),
	]);
	if (!product) return { error: "This product isn't for sale" };
	if (!getPaymentsState(account).ready) return { error: "Payments aren't open for this shop yet" };
	try {
		const { url } = await createProductCheckout({ account, newsletter, product, email, addToList });
		return { url };
	} catch (error) {
		console.error(`[shop] Checkout for product ${product._id} failed: ${error instanceof StripeError ? error.message : error}`);
		return { error: UNAVAILABLE };
	}
}
