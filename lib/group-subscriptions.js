import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getGroupBuyLink, getGroupCompleteLink } from "@/lib/group-links";
import { GROUP_LIMITS } from "@/lib/group-subscription-rules";
import { assertPaymentsReady, getChargeAccount, getPaymentsState } from "@/lib/payments/connect";
import { groupStripeCall, groupStripeRequest as stripeRequest } from "@/lib/group-stripe";
import { getTierPriceId } from "@/lib/payments/tier-prices";
import { getReaderText } from "@/lib/reader-languages";
import { isRateLimited } from "@/lib/rate-limit";
import { getNewsletterTiers, getOfferedTiers, getTierOptions } from "@/lib/tier-rules";
import { normalizeEmail } from "@/lib/validation";
import GroupSubscription from "@/models/GroupSubscription";
import Newsletter from "@/models/Newsletter";

export function groupPlans(newsletter) {
	if (!newsletter.paidTier?.enabled) return [];
	return getOfferedTiers(getNewsletterTiers(newsletter)).filter(tier => !tier.founding?.enabled).flatMap(tier => getTierOptions(tier).filter(option => ["month", "quarter", "year"].includes(option.option)).map(option => ({ tierId: tier.id, name: tier.name, option: option.option, unitAmountCents: option.cents, currency: newsletter.paidTier.currency || "usd" })));
}

export function groupSettings(account, newsletter) {
	const payments = getPaymentsState(account);
	return { newsletterId: String(newsletter._id), enabled: newsletter.groupSubscriptions?.enabled === true, available: payments.ready, problem: payments.problem, minSeats: GROUP_LIMITS.minSeats, maxSeats: GROUP_LIMITS.maxSeats, plans: groupPlans(newsletter) };
}

export async function saveGroupSettings(account, newsletter, enabled) {
	if (enabled) {
		assertPaymentsReady(account);
		if (!groupPlans(newsletter).length) throw actionError("conflict", "Set a regular recurring paid tier before enabling group subscriptions");
	}
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { "groupSubscriptions.enabled": enabled } });
	return groupSettings(account, { ...newsletter, groupSubscriptions: { enabled } });
}

export { findGroup } from "@/lib/group-store";

export function assertGroupChargeAccount(account, group) {
	assertPaymentsReady(account);
	if (group.chargeAccount !== (getChargeAccount(account) ?? "direct")) throw actionError("conflict", "This group's Stripe account changed. The account owner must review it.");
}

function sameCheckout(group, newsletter, input, email) {
	return String(group.newsletterId) === String(newsletter._id) && group.buyerEmail === email && group.tierId === input.tierId && group.option === input.option && group.requestedSeats === input.seats;
}

function sessionForGroup(account, newsletter, group, session) {
	const metadata = session?.metadata ?? {};
	if (!session?.id || metadata.flockstack !== "1" || metadata.kind !== "group_subscription" || metadata.accountId !== String(account._id) || metadata.newsletterId !== String(newsletter._id) || metadata.groupId !== String(group._id)) throw actionError("conflict", "Stripe returned a checkout for another group");
	if (session.status === "expired" || !session.url) throw actionError("conflict", "This checkout is closed. Ask the creator for a new one.");
	return { id: String(group._id), checkoutUrl: session.url };
}

// The buyer still confirms Stripe Checkout. No reader is enrolled and no individual subscription is changed here.
export async function createGroupCheckout({ account, newsletter, input }) {
	assertPaymentsReady(account);
	if (!newsletter.groupSubscriptions?.enabled) throw actionError("conflict", "Group subscriptions aren't open for this newsletter");
	const plan = groupPlans(newsletter).find(plan => plan.tierId === input.tierId && plan.option === input.option);
	const email = normalizeEmail(input.email);
	if (!plan || !email || !Number.isInteger(input.seats) || input.seats < GROUP_LIMITS.minSeats || input.seats > GROUP_LIMITS.maxSeats || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.externalId ?? "")) throw actionError("validation_failed", "Choose a regular plan, a valid buyer email and 2 to 100 seats");
	let group = await GroupSubscription.findOne(scoped(account, { externalId: input.externalId })).lean();
	if (group && !sameCheckout(group, newsletter, input, email)) throw actionError("conflict", "This retry ID belongs to another checkout");
	if (!group) {
		if (await isRateLimited({ name: "group-checkout-account", key: String(account._id), limit: 20, window: "1 h" })) throw actionError("rate_limited", "Too many group checkouts. Try again later.");
		if (await GroupSubscription.countDocuments(scoped(account, { newsletterId: newsletter._id, $or: [{ status: "active" }, { status: "checkout", createdAt: { $gte: new Date(Date.now() - 24 * 3600000) } }] })) >= GROUP_LIMITS.groupsPerNewsletter) throw actionError("conflict", "This newsletter has 100 active groups or recent checkouts. Wait for a pending checkout to expire before starting another.");
		try {
			group = (await GroupSubscription.create({ accountId: account._id, newsletterId: newsletter._id, tierId: plan.tierId, option: plan.option, buyerEmail: email, requestedSeats: input.seats, chargeAccount: getChargeAccount(account) ?? "direct", currency: plan.currency, unitAmountCents: plan.unitAmountCents, externalId: input.externalId })).toObject();
		} catch (error) {
			if (error?.code !== 11000) throw error;
			group = await GroupSubscription.findOne(scoped(account, { externalId: input.externalId })).lean();
			if (!group || !sameCheckout(group, newsletter, input, email)) throw actionError("conflict", "This retry ID belongs to another checkout");
		}
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { hasGroupSubscriptions: true } });
	}
	assertGroupChargeAccount(account, group);
	const chargeAccount = getChargeAccount(account);
	if (group.stripeSessionId) {
		const session = await stripeRequest(`/v1/checkout/sessions/${group.stripeSessionId}`, { account: chargeAccount });
		return sessionForGroup(account, newsletter, group, session);
	}
	if (group.status !== "checkout" || group.checkoutStartedAt && Date.now() - +new Date(group.checkoutStartedAt) > 23 * 3600000) throw actionError("conflict", "This checkout needs review before it can be retried");
	const tier = getNewsletterTiers(newsletter).find(tier => tier.id === plan.tierId);
	if (group.currency !== plan.currency || group.unitAmountCents !== plan.unitAmountCents) throw actionError("conflict", "The group's price changed. Ask the creator for a new checkout.");
	const priceId = group.priceId ?? await groupStripeCall(() => getTierPriceId({ account, newsletter, tier, option: plan.option }));
	if (!priceId) throw actionError("conflict", "This group's recurring price is unavailable");
	const startedAt = group.checkoutStartedAt ?? new Date();
	const prepared = await GroupSubscription.updateOne(scoped(account, { _id: group._id, status: "checkout" }), { $set: { priceId, checkoutStartedAt: startedAt } });
	if (!prepared.matchedCount) throw actionError("conflict", "This group checkout changed. Refresh it before continuing.");
	const metadata = { flockstack: "1", kind: "group_subscription", accountId: String(account._id), newsletterId: String(newsletter._id), groupId: String(group._id), tierId: tier.id };
	const t = getReaderText(newsletter);
	const session = await stripeRequest("/v1/checkout/sessions", { method: "POST", account: chargeAccount, idempotencyKey: `flockstack-group-checkout-${group._id}`, params: {
		mode: "subscription", line_items: [{ price: priceId, quantity: group.requestedSeats }], customer_email: email,
		metadata, subscription_data: { metadata },
		success_url: getGroupCompleteLink(newsletter),
		cancel_url: getGroupBuyLink(newsletter),
		custom_text: { submit: { message: t("One buyer pays per seat. Each reader must accept their own invitation. Individual subscriptions stay unchanged.") + " " + t("Seats activate after payment and each reader's acceptance.") } },
	} });
	const result = sessionForGroup(account, newsletter, group, session);
	const stored = await GroupSubscription.updateOne(scoped(account, { _id: group._id, status: "checkout" }), { $set: { stripeSessionId: session.id } });
	if (!stored.matchedCount) throw actionError("conflict", "This checkout needs the creator's review before continuing");
	return result;
}
