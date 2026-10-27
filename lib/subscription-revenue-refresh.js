import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getChargeAccount, getPaymentsState } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { observeSubscriptionFinancial, observeSubscriptionInvoice } from "@/lib/subscription-revenue";
import { readFinancialDiscounts } from "@/lib/subscription-revenue-discounts";
import { isObjectIdString } from "@/lib/validation";
import GroupSubscription from "@/models/GroupSubscription";
import Contact from "@/models/Contact";
import ImportedSubscription from "@/models/ImportedSubscription";

const PAGE = 20;
export async function refreshSubscriptionRevenue({ account, newsletter, cursor }) {
	if (!getPaymentsState(account).ready) throw actionError("payments_not_ready", "Connect your Stripe account before refreshing its financial snapshots");
	let groupPage = cursor === "groups" || cursor?.startsWith("g:");
	const after = cursor?.startsWith("g:") ? cursor.slice(2) : groupPage ? null : cursor;
	if (after && !isObjectIdString(after)) throw actionError("validation_failed", "Use the next cursor from the previous refresh");
	let contacts = groupPage ? [] : await Contact.find(scoped(account, { newsletterId: newsletter._id, stripeSubscriptionId: { $type: "string" }, ...(after && { _id: { $gt: after } }) })).sort({ _id: 1 }).select("stripeSubscriptionId").limit(PAGE + 1).lean();
	if (!contacts.length) groupPage = true;
	if (groupPage) contacts = await GroupSubscription.find(scoped(account, { newsletterId: newsletter._id, stripeSubscriptionId: { $type: "string" }, ...(after && cursor?.startsWith("g:") && { _id: { $gt: after } }) })).sort({ _id: 1 }).select("stripeSubscriptionId").limit(PAGE + 1).lean();
	const page = contacts.slice(0, PAGE), ids = [...new Set(page.map(contact => contact.stripeSubscriptionId))];
	const chargeAccount = getChargeAccount(account);
	const budget = { remaining: 10, deadline: Date.now() + 45000, coupons: new Map() };
	async function readMetadata(subscription) {
		const metadata = subscription.metadata ?? {};
		if (metadata.flockstack === "1") {
			if (metadata.accountId !== String(account._id) || metadata.newsletterId !== String(newsletter._id)) return null;
			if (metadata.kind === "paid_tier") return metadata;
			if (metadata.kind !== "group_subscription" || !isObjectIdString(metadata.groupId ?? "")) return null;
			const owned = await GroupSubscription.findOne(scoped(account, { _id: metadata.groupId, newsletterId: newsletter._id, stripeSubscriptionId: subscription.id, chargeAccount: chargeAccount ?? "direct", tierId: metadata.tierId })).select("_id").lean();
			return owned ? metadata : null;
		}
		const mapping = await ImportedSubscription.findOne(scoped(account, { stripeSubscriptionId: subscription.id, newsletterId: newsletter._id, chargeAccount: chargeAccount ?? "direct" })).select("tierId").lean();
		return mapping ? { tierId: mapping.tierId } : null;
	}
	const processed = new Set();
	let timeLimited = false;
	let updated = 0, skipped = 0, invoicesRecorded = 0;
	for (const id of ids) {
		if (Date.now() >= budget.deadline) { timeLimited = true; break; }
		processed.add(id);
		if (!/^sub_[A-Za-z0-9_]{1,96}$/.test(id)) { skipped++; continue; }
		try {
			let observedAt = new Date();
			let subscription = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(id)}`, { account: chargeAccount, timeout: 5000 });
			if (subscription.id !== id) { skipped++; continue; }
			if (!await readMetadata(subscription)) { skipped++; continue; }
			({ subscription, observedAt } = await readFinancialDiscounts(subscription, { chargeAccount, budget, observedAt, isAllowed: async (value) => Boolean(await readMetadata(value)) }));
			if (!subscription) { skipped++; continue; }
			const metadata = await readMetadata(subscription);
			if (!metadata) { skipped++; continue; }
			await observeSubscriptionFinancial({ account, newsletter, subscription: { ...subscription, metadata }, source: "refresh", observedAt });
			updated++;
			let invoice = subscription.latest_invoice;
			const invoiceAt = new Date();
			if (typeof invoice === "string" && /^in_[A-Za-z0-9_]{1,96}$/.test(invoice) && Date.now() < budget.deadline) invoice = await stripeRequest(`/v1/invoices/${encodeURIComponent(invoice)}`, { account: chargeAccount, timeout: 5000 });
			if (invoice && typeof invoice === "object") {
				const result = await observeSubscriptionInvoice({ account, newsletter, subscriptionId: id, invoice, source: "refresh", observedAt: invoiceAt });
				if (result.recorded) invoicesRecorded++;
			}
		} catch { skipped++; }
	}
	let scanned = 0;
	for (const contact of page) { if (!processed.has(contact.stripeSubscriptionId)) break; scanned++; }
	if (page.length && !scanned) throw actionError("unavailable", "The provider read budget was reached; try refreshing again");
	let next = scanned && (scanned < page.length || contacts.length > PAGE) ? `${groupPage ? "g:" : ""}${page[scanned - 1]._id}` : null;
	if (!next && !groupPage && await GroupSubscription.exists(scoped(account, { newsletterId: newsletter._id, stripeSubscriptionId: { $type: "string" } }))) next = "groups";
	return { contactsScanned: groupPage ? 0 : scanned, groupsScanned: groupPage ? scanned : 0, subscriptionsObserved: updated, skipped, invoicesRecorded, timeLimited, cursor: next, basis: "Refreshes known individual and group subscriptions, bounded discount terms and at most their latest invoice. Does not import older history, enumerate your whole Stripe account, change billing or access, or email anyone. A failed invoice lookup can leave a refreshed subscription counted above and a skipped lookup." };
}
