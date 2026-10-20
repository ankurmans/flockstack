import "server-only";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { createBillingPortalSession, createProductCheckout, createSubscriptionCheckout } from "@/lib/payments/checkout";
import { getPaymentsState } from "@/lib/payments/connect";
import { StripeError } from "@/lib/payments/stripe-api";
import { readPortalToken } from "@/lib/portal-link";
import { PRODUCT_SLUG_PATTERN } from "@/lib/products";
import { isRateLimited } from "@/lib/rate-limit";
import { TIER_OPTIONS, findTier, getNewsletterTiers, getOfferedTiers, getTierOptions } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Product from "@/models/Product";

const PER_IP = { name: "checkout-ip", limit: 20, window: "10 m" };
const UNAVAILABLE = "Checkout isn't available right now. Try again in a minute.";

const SUBSCRIBE_PER_IP = { name: "subscribe-paid-ip", limit: 20, window: "10 m" };

// A reader subscribes to one of the newsletter's paid tiers from its subscribe page. Resolves to the Checkout URL or the words to
// show them. The price comes from the newsletter's settings; the form only picks a tier and a way to pay (option: month, quarter,
// year, lifetime or pwyw) and gives an email.
export async function startPaidSubscription({ newsletterSlug, tierId, option, interval, email, offerCode, ip }) {
	if (await isRateLimited({ ...SUBSCRIBE_PER_IP, key: ip })) return { error: "Too many attempts from your network. Try again in a few minutes." };
	const wanted = option || interval;
	if (!TIER_OPTIONS.includes(wanted)) return { error: "Pick a plan" };
	const address = normalizeEmail(email ?? "");
	if (!address) return { error: "Enter a valid email" };
	const newsletter = await getArchiveNewsletter(newsletterSlug);
	const tiers = getNewsletterTiers(newsletter);
	const tier = findTier(tiers, tierId || getOfferedTiers(tiers)[0]?.id);
	if (!newsletter?.paidTier?.enabled || !tier || tier.archived || !getTierOptions(tier).some((way) => way.option === wanted)) {
		return { error: "This newsletter doesn't offer that plan" };
	}

	await connectDb();
	const account = await Account.findById(newsletter.accountId).lean();
	if (!getPaymentsState(account).ready) return { error: "Payments aren't open for this newsletter yet" };
	const existing = await Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, email: address }).select({ tier: 1, paidUntil: 1 }).lean();
	if (isPaidContact(existing)) return { error: "You're already a paid subscriber. Use the manage link at the bottom of any issue to change your plan." };
	try {
		const { url } = await createSubscriptionCheckout({ account, newsletter, tierId: tier.id, option: wanted, email: address, offerCode });
		return { url };
	} catch (error) {
		if (error?.code === "conflict") return { error: error.message };
		if (error instanceof StripeError && /^coupon/.test(error.stripeCode ?? "")) return { error: "This offer has ended" };
		console.error(`[shop] Paid checkout for newsletter ${newsletter._id} failed: ${error instanceof StripeError ? error.message : error}`);
		return { error: UNAVAILABLE };
	}
}

// The link in a paid reader's emails: their Stripe billing page. Resolves to the page's URL, or null with nothing to show.
export async function openSubscriberPortal({ token, ip }) {
	if (await isRateLimited({ name: "portal-ip", limit: 30, window: "10 m", key: ip })) return { error: "Too many attempts from your network. Try again in a few minutes." };
	const reference = readPortalToken(token);
	if (!reference) return { error: "This link has expired or isn't valid. Use the link in a more recent email." };
	await connectDb();
	const contact = await Contact.findOne({ _id: reference.contactId, newsletterId: reference.newsletterId }).setOptions({ crossAccount: true }).lean();
	if (!contact?.stripeCustomerId) return { error: "There's no subscription to manage for this address." };
	const [account, newsletter] = await Promise.all([
		Account.findById(contact.accountId).lean(),
		Newsletter.findOne({ accountId: contact.accountId, _id: contact.newsletterId }).lean(),
	]);
	if (!account || !newsletter) return { error: "There's no subscription to manage for this address." };
	try {
		const url = await createBillingPortalSession({ account, customerId: contact.stripeCustomerId, returnUrl: getArchiveUrls(newsletter).absoluteSubscribe });
		return { url };
	} catch (error) {
		console.error(`[shop] The billing portal for contact ${contact._id} failed: ${error instanceof StripeError ? error.message : error}`);
		return { error: "The billing page isn't available right now. Try again in a minute." };
	}
}

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
