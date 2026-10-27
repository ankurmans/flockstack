import { createSeller } from "./shop.mjs";

let count = 0;
export async function groupModels() {
	return { groups: await import("../../lib/group-subscriptions.js"), billing: await import("../../lib/group-billing.js"), seats: await import("../../lib/group-seats.js"), links: await import("../../lib/group-links.js"), access: await import("../../lib/paid-access.js"), Group: (await import("../../models/GroupSubscription.js")).default, Contact: (await import("../../models/Contact.js")).default, Newsletter: (await import("../../models/Newsletter.js")).default, Account: (await import("../../models/Account.js")).default };
}

export async function fundedGroup(m, fake) {
	const user = await createSeller(`group-seats${++count}@example.com`, { fake });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { groupSubscriptions: { enabled: true }, paidTier: { enabled: true, currency: "usd" }, paidTiers: [{ id: "basic", name: "Basic", prices: { month: 800 } }, { id: "premium", name: "Premium", prices: { month: 1600 } }] } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const group = (await m.Group.create({ accountId: user.accountId, newsletterId: user.newsletterId, tierId: "premium", option: "month", buyerEmail: "group-buyer@example.com", buyerVerifiedAt: new Date(), requestedSeats: 2, priceId: "price_seats", currency: "usd", chargeAccount: user.stripeAccountId })).toObject();
	const customer = fake.addCustomer({ email: group.buyerEmail });
	const end = Math.floor(Date.now() / 1000) + 30 * 86400;
	const subscription = fake.addSubscription({ customer: customer.id, metadata: { flockstack: "1", kind: "group_subscription", accountId: String(user.accountId), newsletterId: String(user.newsletterId), groupId: String(group._id), tierId: group.tierId }, current_period_end: end, items: { data: [{ id: "si_seats", quantity: 2, price: { id: group.priceId, currency: "usd", unit_amount: 1600, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] } });
	const invoice = { id: `in_seats_${count}`, status: "paid", paid: true, currency: "usd", subscription: subscription.id, customer: customer.id, amount_paid: 3200, status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, lines: { data: [{ price: group.priceId, quantity: 2, amount: 3200, period: { end } }] } };
	fake.invoices.set(invoice.id, invoice); subscription.latest_invoice = invoice.id;
	await m.Group.updateOne({ accountId: user.accountId, _id: group._id }, { $set: { stripeSubscriptionId: subscription.id, stripeCustomerId: customer.id } });
	await m.billing.refreshGroupBilling({ account: user.account, groupId: group._id });
	return { user, group: await m.groups.findGroup(user.account, group._id), customer, subscription, invoice };
}

export async function invite(m, state, email) {
	const result = await m.seats.inviteGroupSeat({ account: state.user.account, groupId: state.group._id, email });
	const group = await m.groups.findGroup(state.user.account, state.group._id);
	const seat = group.seats.find(seat => seat.id === result.id);
	const token = new URL(m.links.getGroupSeatLink(group, seat)).searchParams.get("token");
	return { result, group, seat, token };
}
