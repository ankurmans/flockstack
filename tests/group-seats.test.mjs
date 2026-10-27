import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { fundedGroup, groupModels, invite } from "./helpers/groups.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = await groupModels(); });
after(() => app?.stop());
const accept = (invitation, extra = {}) => m.seats.acceptGroupSeat({ token: invitation.token, email: invitation.seat.email, subscribe: true, ...extra });

test("inviting does not enroll a reader; acceptance needs recipient consent and retries reuse its seat", async () => {
	const s = await fundedGroup(m, fake), invitation = await invite(m, s, "recipient@example.com");
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	assert.equal(invitation.result.status, "invited"); assert.equal(invitation.result.sent, true);
	assert.equal(Object.hasOwn(invitation.result, "token"), false);
	await assert.rejects(accept(invitation, { subscribe: false }), error => error.code === "validation_failed");
	await assert.rejects(accept(invitation, { email: "other@example.com" }), error => error.code === "validation_failed");
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	const result = await accept(invitation);
	assert.equal(result.contact.status, "active"); assert.equal(result.contact.paidSource, "group"); assert.equal(result.contact.paidTierId, "premium"); assert.equal(result.contact.stripeSubscriptionId, undefined);
	const again = await accept(invitation); assert.equal(String(again.contact._id), String(result.contact._id));
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 1);
});

test("two concurrent invitations cannot take the last funded seat twice", async () => {
	const s = await fundedGroup(m, fake); await invite(m, s, "first@example.com");
	const results = await Promise.allSettled([invite(m, s, "second@example.com"), invite(m, s, "third@example.com")]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(results.filter(result => result.status === "rejected").length, 1);
	assert.equal((await m.groups.findGroup(s.user.account, s.group._id)).seats.filter(seat => seat.status !== "revoked").length, 2);
});

test("revocation restores an individual subscription and invalidates the old recipient capability", async () => {
	const s = await fundedGroup(m, fake);
	const until = new Date(Date.now() + 90 * 86400000);
	const personal = await m.Contact.create({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, email: "overlap@example.com", status: "active", tier: "paid", paidTierId: "basic", paidUntil: until, paidInterval: "month", stripeSubscriptionId: "sub_overlap", stripeCustomerId: "cus_overlap", subscriptionStatus: "active" });
	const invitation = await invite(m, s, personal.email), accepted = await accept(invitation);
	assert.equal(accepted.contact.paidSource, "group"); assert.equal(accepted.contact.stripeSubscriptionId, "sub_overlap");
	await m.seats.revokeGroupSeat({ account: s.user.account, groupId: s.group._id, seatId: invitation.seat.id });
	const reader = await m.Contact.findOne({ accountId: s.user.accountId, _id: personal._id }).lean();
	assert.equal(reader.paidSource, "personal"); assert.equal(reader.paidTierId, "basic"); assert.equal(+reader.paidUntil, +until); assert.equal(reader.groupIds.length, 0);
	await assert.rejects(accept(invitation), error => error.code === "not_found");
	const replacement = await invite(m, s, "replacement@example.com");
	assert.notEqual(replacement.seat.id, invitation.seat.id);
	assert.equal((await m.groups.findGroup(s.user.account, s.group._id)).seats.length, 1);
});

test("failed billing immediately removes group access and later payment restores its accepted readers", async () => {
	const s = await fundedGroup(m, fake), invitation = await invite(m, s, "funded@example.com");
	const accepted = await accept(invitation);
	s.subscription.status = "past_due"; await m.billing.refreshGroupBilling({ account: s.user.account, groupId: s.group._id });
	let reader = await m.Contact.findOne({ accountId: s.user.accountId, _id: accepted.contact._id }).lean();
	assert.equal(reader.tier, "free"); assert.equal(reader.groupIds.length, 1);
	s.subscription.status = "active"; await m.billing.refreshGroupBilling({ account: s.user.account, groupId: s.group._id });
	reader = await m.Contact.findOne({ accountId: s.user.accountId, _id: accepted.contact._id }).lean(); assert.equal(reader.paidSource, "group");
	await m.Group.updateOne({ accountId: s.user.accountId, _id: s.group._id }, { $set: { paidUntil: new Date(Date.now() - 1000) } });
	reader = await m.access.refreshGroupReader(s.user.newsletter, reader); assert.equal(reader.tier, "free");
});

test("suppressed and deleted readers cannot gain an active seat, and reader deletion clears seat identity", async () => {
	const s = await fundedGroup(m, fake), invitation = await invite(m, s, "suppressed@example.com");
	const Suppression = (await import("../models/Suppression.js")).default;
	await Suppression.create({ accountId: s.user.accountId, email: invitation.seat.email, reason: "complaint" });
	await assert.rejects(accept(invitation), error => error.code === "conflict");
	assert.notEqual((await m.groups.findGroup(s.user.account, s.group._id)).seats[0].status, "active");
	const good = await invite(m, s, "delete-seat@example.com"), result = await accept(good);
	await (await import("../lib/contacts.js")).removeContact(s.user.account, result.contact);
	const seat = (await m.groups.findGroup(s.user.account, s.group._id)).seats.find(seat => seat.id === good.seat.id);
	assert.equal(seat.status, "revoked"); assert.equal(seat.email, undefined); assert.equal(seat.contactId, undefined);
	await assert.rejects(accept(good), error => error.code === "not_found");
});

test("manager version rotation revokes old capabilities and blocked accounts cannot invite or accept", async () => {
	const s = await fundedGroup(m, fake);
	const token = new URL(m.links.getGroupManagerLink(s.group)).searchParams.get("token");
	assert.equal(String((await m.seats.readGroupContext(token, "manager")).group._id), String(s.group._id));
	await m.seats.sendGroupManagerLink({ account: s.user.account, groupId: s.group._id, rotate: true });
	await assert.rejects(m.seats.readGroupContext(token, "manager"), error => error.code === "not_found");
	const invitation = await invite(m, s, "blocked-seat@example.com");
	await m.Account.updateOne({ _id: s.user.accountId }, { $set: { status: "paused" } });
	await assert.rejects(accept(invitation), error => error.code === "account_blocked");
	await assert.rejects(invite(m, s, "new-seat@example.com"), error => error.code === "account_blocked");
});

test("concurrent acceptance reuses one reader and group revocation preserves a lifetime purchase or a gift", async () => {
	const s = await fundedGroup(m, fake);
	for (const source of ["lifetime", "gift"]) {
		const until = new Date(source === "lifetime" ? "2099-12-31T00:00:00Z" : Date.now() + 90 * 86400000);
		const reader = await m.Contact.create({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, email: `${source}@example.com`, status: "active", tier: "paid", paidTierId: "basic", paidUntil: source === "gift" ? new Date(+until - 3 * 86400000) : until, ...(source === "lifetime" ? { paidInterval: "lifetime", lifetimePaymentIntentId: "pi_owned_lifetime" } : { grant: { kind: "gift", tierId: "basic", until }, giftReceipts: { prior: until.toISOString() } }) });
		const invitation = await invite(m, s, reader.email);
		const results = await Promise.allSettled([accept(invitation), accept(invitation)]);
		assert.ok(results.some(result => result.status === "fulfilled"));
		for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "conflict", "a newer provider read can require retrying the older click");
		const again = await accept(invitation);
		assert.equal(String(again.contact._id), String(reader._id)); assert.equal(again.contact.paidSource, "group");
		await m.seats.revokeGroupSeat({ account: s.user.account, groupId: s.group._id, seatId: invitation.seat.id });
		const restored = await m.Contact.findOne({ accountId: s.user.accountId, _id: reader._id }).lean();
		assert.equal(restored.paidTierId, "basic"); assert.equal(restored.tier, "paid");
		if (source === "lifetime") { assert.equal(restored.paidInterval, "lifetime"); assert.equal(restored.lifetimePaymentIntentId, "pi_owned_lifetime"); }
		else { assert.equal(restored.paidSource, "grant"); assert.equal(restored.giftReceipts.prior, until.toISOString()); }
	}
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 2);
});
