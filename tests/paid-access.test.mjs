import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { addReader, createPublisher, importModels } from "./helpers/community.mjs";
let app, m, counter = 0;
before(async () => {
	app = await startTestApp();
	m = { ...(await importModels()), Group: (await import("../models/GroupSubscription.js")).default, access: await import("../lib/paid-access.js") };
});
after(() => app?.stop());
async function setup() {
	const user = await createPublisher(m, `paid-access${++counter}@example.com`);
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTiers: [{ id: "basic", name: "Basic", prices: { month: 800 } }, { id: "premium", name: "Premium", prices: { month: 1600 } }] } });
	const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const reader = await addReader(m, user, "reader@example.com", { tier: "paid", paidTierId: "basic", paidUntil: new Date(Date.now() + 30 * 86400000), paidInterval: "month", subscriptionStatus: "active", stripeSubscriptionId: "sub_personal" });
	const group = await m.Group.create({ accountId: user.accountId, newsletterId: user.newsletterId, tierId: "premium", option: "month", buyerEmail: "buyer@example.com", requestedSeats: 2, capacity: 2, chargeAccount: "direct", status: "active", subscriptionStatus: "active", paidUntil: new Date(Date.now() + 30 * 86400000), seats: [{ id: "seat", email: reader.email, contactId: reader._id, status: "active", consentedAt: new Date() }] });
	return { user, newsletter, reader, group };
}
const refresh = s => m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id });

test("projected group access preserves personal billing and returns to it when the group stops paying", async () => {
	const s = await setup();
	const joined = await m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id, change: () => ({ set: { groupIds: [s.group._id] } }) });
	assert.equal(joined.contact.paidSource, "group"); assert.equal(joined.contact.paidTierId, "premium");
	assert.equal(joined.contact.stripeSubscriptionId, "sub_personal"); assert.equal(+joined.contact.paidPersonal.until, +s.reader.paidUntil);
	await m.Group.updateOne({ accountId: s.user.accountId, _id: s.group._id }, { $set: { subscriptionStatus: "past_due" } });
	const restored = await refresh(s); assert.equal(restored.contact.paidSource, "personal"); assert.equal(restored.contact.paidTierId, "basic"); assert.equal(+restored.contact.paidUntil, +s.reader.paidUntil); assert.equal(restored.contact.groupAccess, undefined);
	assert.equal((await refresh(s)).changed, false);
});

test("concurrent renewal and group revocation keep the new individual paid period", async () => {
	const s = await setup();
	await m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id, change: () => ({ set: { groupIds: [s.group._id] } }) });
	await m.Group.updateOne({ accountId: s.user.accountId, _id: s.group._id }, { $set: { subscriptionStatus: "canceled" } });
	const until = new Date(Date.now() + 90 * 86400000);
	await Promise.all([refresh(s), m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id, change: () => ({ set: { paidPersonal: { kind: "stripe", status: "active", tierId: "basic", until, interval: "month", subscriptionId: "sub_personal" } } }) })]);
	const contact = await m.Contact.findOne({ accountId: s.user.accountId, _id: s.reader._id }).lean();
	assert.equal(contact.paidSource, "personal"); assert.equal(+contact.paidUntil, +until); assert.ok(contact.paidAccessRevision >= 2);
});

test("another account's or publication's group never grants access through an injected reference", async () => {
	const s = await setup(), other = await setup();
	const answer = await m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id, change: () => ({ set: { groupIds: [other.group._id] } }) });
	assert.equal(answer.contact.paidSource, "personal");
	await assert.rejects(m.access.updatePaidAccess({ account: other.user.account, newsletter: other.newsletter, contactId: s.reader._id }), error => error.code === "not_found");
});

test("an expired group projection still selects its valid personal fallback in real audience queries", async () => {
	const s = await setup();
	await m.access.updatePaidAccess({ account: s.user.account, newsletter: s.newsletter, contactId: s.reader._id, change: () => ({ set: { groupIds: [s.group._id] } }) });
	const { PAID_GRACE_MS, isPaidContact, isInPaidTiers } = await import("../lib/tiers.js");
	const { buildAudienceQuery, selectAudience } = await import("../lib/audience.js");
	const expired = new Date(Date.now() - PAID_GRACE_MS - 1000);
	await m.Contact.updateOne({ accountId: s.user.accountId, _id: s.reader._id }, { $set: { paidUntil: expired } });
	const raw = await m.Contact.findOne({ accountId: s.user.accountId, _id: s.reader._id }).lean();
	assert.equal(raw.paidTierId, "premium"); assert.equal(isPaidContact(raw), true); assert.equal(isInPaidTiers(raw, ["basic"]), true); assert.equal(isInPaidTiers(raw, ["premium"]), false);
	for (const [audience, tiers, count] of [["paid", ["basic"], 1], ["paid", ["premium"], 0], ["free", null, 0]]) {
		const query = buildAudienceQuery({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, audience, audienceTiers: tiers, segmentFilter: { email: raw.email } });
		assert.equal(await m.Contact.countDocuments(query.filter), count);
		assert.equal(selectAudience([raw], { audience, audienceTiers: tiers }).length, count);
	}
	await m.Contact.updateOne({ accountId: s.user.accountId, _id: s.reader._id }, { $set: { paidPersonal: null, grant: { kind: "gift", tierId: "basic", until: new Date(Date.now() + 86400000) } } });
	const giftQuery = buildAudienceQuery({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, audience: "paid", audienceTiers: ["basic"] });
	assert.equal(await m.Contact.countDocuments(giftQuery.filter), 1);
});
