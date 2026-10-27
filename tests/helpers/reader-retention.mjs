import { createSeller } from "./shop.mjs";
let count = 0;
export async function retentionModels() {
	return { store: await import("../../lib/reader-retention-store.js"), rules: await import("../../lib/reader-retention-rules.js"), Account: (await import("../../models/Account.js")).default, Newsletter: (await import("../../models/Newsletter.js")).default, Contact: (await import("../../models/Contact.js")).default, Retention: (await import("../../models/ReaderRetention.js")).default, Response: (await import("../../models/CancellationResponse.js")).default };
}
export async function retentionReader(m, fake, extra = {}) {
	const user = await createSeller(`retention-publisher${++count}@example.com`, { fake });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "readerRetention.pauseEnabled": true, "readerRetention.surveyEnabled": true } });
	const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const customer = fake.addCustomer({ email: `retention-reader${count}@example.com` });
	const end = Math.floor(Date.now() / 1000) + 864000;
	const subscription = fake.addSubscription({ customer: customer.id, status: "active", currency: "usd", billing_mode: { type: "flexible" }, collection_method: "charge_automatically", metadata: { flockstack: "1", kind: "paid_tier", accountId: user.accountId, newsletterId: user.newsletterId, tierId: "paid" }, items: { data: [{ id: `si_retention_${count}`, quantity: 1, current_period_end: end, price: { id: `price_retention_${count}`, type: "recurring", billing_scheme: "per_unit", currency: "usd", unit_amount: 1000, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] }, ...extra });
	const contact = (await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: customer.email, status: "active", tier: "paid", paidUntil: new Date(end * 1000), paidTierId: "paid", paidInterval: "month", stripeSubscriptionId: subscription.id, stripeCustomerId: customer.id, subscriptionStatus: "active", paidSource: "personal", paidPersonal: { kind: "stripe", status: "active", tierId: "paid", interval: "month", subscriptionId: subscription.id, until: new Date(end * 1000) } })).toObject();
	return { user, newsletter, customer, subscription, contact, target: { account: user.account, newsletterId: user.newsletterId, contactId: contact._id } };
}
