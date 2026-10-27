import { scoped } from "@/lib/account-scope";
import { randomUUID } from "node:crypto";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter } from "@/lib/actions/shared";
import { getChargeAccount, getPaymentsState } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { getSubscriptionTier } from "@/lib/payments/subscriptions";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { normalizeEmail } from "@/lib/validation";
import { upsertContact } from "@/lib/contacts";
import Contact from "@/models/Contact";
import ImportedSubscription from "@/models/ImportedSubscription";
import GroupSubscription from "@/models/GroupSubscription";
import { updatePaidAccess } from "@/lib/paid-access";

export async function importStripeSubscribers(account, input) {
	const newsletter = await findNewsletter(account, input.newsletter);
	if (!getPaymentsState(account).ready) throw actionError("conflict", "Connect your own Stripe account first");
	const chargeAccount = getChargeAccount(account);
	const rows = [];
	for (const id of [...new Set(input.subscriptions)]) {
		try {
			const subscription = await stripeRequest(`/v1/subscriptions/${id}`, { account: chargeAccount });
			if (subscription.metadata?.flockstack === "1" && subscription.metadata.kind !== "paid_tier" || await GroupSubscription.exists(scoped(account, { stripeSubscriptionId: id }))) throw actionError("conflict", "Group subscriptions and other sales cannot be imported as an individual reader");
			if (subscription.metadata?.flockstack === "1" && (subscription.metadata.accountId !== String(account._id) || subscription.metadata.newsletterId !== String(newsletter._id))) throw actionError("conflict", "This subscription already belongs to another newsletter");
			const held = await Contact.findOne(scoped(account, { stripeSubscriptionId: id, newsletterId: { $ne: newsletter._id } })).select({ _id: 1 }).lean();
			if (held) throw actionError("conflict", "This subscription already belongs to another newsletter");
			const items = subscription.items?.data ?? [];
			if (items.length !== 1 || subscription.items?.has_more) throw actionError("validation_failed", "Only single-price subscriptions can be imported");
			const priceId = items[0].price?.id ?? items[0].plan?.id;
			const tierId = input.prices[priceId];
			if (!tierId || !findTier(getNewsletterTiers(newsletter), tierId)) throw actionError("validation_failed", "Map this price to an existing paid tier");
			const next = getSubscriptionTier(subscription);
			if (next.tier !== "paid" || !next.paidUntil || +next.paidUntil <= Date.now()) throw actionError("validation_failed", "Subscription has no current paid or trial access");
			const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
			if (!/^cus_[A-Za-z0-9]+$/.test(customerId ?? "")) throw actionError("validation_failed", "Subscription has no customer");
			const customer = await stripeRequest(`/v1/customers/${customerId}`, { account: chargeAccount });
			const email = normalizeEmail(customer.email ?? "");
			if (!email || customer.deleted) throw actionError("validation_failed", "Customer has no valid email");
			const existing = await ImportedSubscription.findOne(scoped(account, { stripeSubscriptionId: id })).lean();
			if (existing && (String(existing.newsletterId) !== String(newsletter._id) || existing.chargeAccount !== (chargeAccount ?? "direct") || existing.tierId !== tierId)) throw actionError("conflict", "Subscription is already mapped elsewhere");
			const contact = await Contact.findOne(scoped(account, { newsletterId: newsletter._id, email })).lean();
			if (contact?.stripeSubscriptionId && contact.stripeSubscriptionId !== id) throw actionError("conflict", "This reader already has a different subscription");
			if (!input.apply) { rows.push({ id, status: "ready", priceId, tierId, paidUntil: next.paidUntil.toISOString(), error: null }); continue; }
			if (!input.consent) throw actionError("validation_failed", "Confirm these readers agreed to receive this newsletter");
			await ImportedSubscription.updateOne(scoped(account, { stripeSubscriptionId: id }), { $setOnInsert: { newsletterId: newsletter._id, chargeAccount: chargeAccount ?? "direct", priceId, tierId } }, { upsert: true });
			const saved = await ImportedSubscription.findOne(scoped(account, { stripeSubscriptionId: id })).lean();
			if (String(saved.newsletterId) !== String(newsletter._id) || saved.tierId !== tierId || saved.chargeAccount !== (chargeAccount ?? "direct")) throw actionError("conflict", "Subscription mapping changed");
			const result = await upsertContact({ newsletter, email, source: "stripe_import", resubscribe: false, consent: { at: new Date(), source: "stripe_import" }, enroll: false });
			const lease = randomUUID();
			const claimed = await Contact.updateOne(scoped(account, { _id: result.contact._id }), { $set: { paidPersonalLease: lease } });
			if (!claimed.matchedCount) throw actionError("conflict", "The reader was deleted during import");
			const currentAt = new Date();
			const current = await stripeRequest(`/v1/subscriptions/${id}`, { account: chargeAccount });
			const currentTier = getSubscriptionTier(current);
			const metadata = current.metadata;
			if (current.id !== id || currentTier.tier !== "paid" || !currentTier.paidUntil || +currentTier.paidUntil <= Date.now() || current.items?.has_more || current.items?.data?.length !== 1 || (current.items.data[0].price?.id ?? current.items.data[0].plan?.id) !== priceId || (typeof current.customer === "string" ? current.customer : current.customer?.id) !== customerId || metadata?.flockstack === "1" && (metadata.kind !== "paid_tier" || metadata.accountId !== String(account._id) || metadata.newsletterId !== String(newsletter._id))) throw actionError("conflict", "The subscription changed during import. Preview it again.");
			await updatePaidAccess({ account, newsletter, contactId: result.contact._id, change: fresh => {
				if (fresh.paidPersonalLease !== lease || fresh.stripeSubscriptionId && fresh.stripeSubscriptionId !== id) throw actionError("conflict", "This reader's individual billing changed during import");
				return { guard: { paidPersonalLease: lease }, set: { paidPersonal: { kind: "stripe", status: current.status, tierId, until: currentTier.paidUntil, interval: currentTier.paidInterval, subscriptionId: id, observedAt: currentAt }, stripeSubscriptionId: id, stripeCustomerId: customerId, subscriptionStatus: current.status } };
			} });
			await ImportedSubscription.updateOne(scoped(account, { _id: saved._id }), { $set: { contactId: result.contact._id } });
			try {
				await (await import("@/lib/subscription-revenue")).captureSubscriptionFinancial({ account, newsletter, subscription: { ...current, metadata: { tierId } }, source: "import", observedAt: currentAt });
			} catch { console.error(`[subscription-revenue] Reporting module unavailable for account ${account._id}`); }
			rows.push({ id, status: "imported", priceId, tierId, paidUntil: currentTier.paidUntil.toISOString(), error: null });
		} catch (error) {
			rows.push({ id, status: "failed", priceId: null, tierId: null, paidUntil: null, error: error.code === "validation_failed" || error.code === "conflict" ? error.message : "Could not read or import this subscription from your Stripe account" });
		}
	}
	return { applied: Boolean(input.apply), rows, emailsSent: 0, chargesCreated: 0 };
}
