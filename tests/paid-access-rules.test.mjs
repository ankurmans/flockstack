import assert from "node:assert/strict";
import { test } from "node:test";
import { paidAccessUpdate, readPersonalAccess, resolvePaidAccess } from "../lib/paid-access-rules.js";
const NOW = Date.parse("2026-10-25T12:00:00Z"), UNTIL = new Date(NOW + 30 * 86400000);
const newsletter = { paidTiers: [{ id: "basic", name: "Basic", prices: { month: 800 } }, { id: "premium", name: "Premium", prices: { month: 1600 } }] };
const reader = extra => ({ _id: "reader", accountId: "account", newsletterId: "newsletter", email: "reader@example.com", status: "active", tier: "paid", paidUntil: UNTIL, paidTierId: "basic", paidInterval: "month", subscriptionStatus: "active", stripeSubscriptionId: "sub_personal", ...extra });
const group = extra => ({ _id: "group", status: "active", accountId: "account", newsletterId: "newsletter", tierId: "premium", subscriptionStatus: "active", paidUntil: new Date(NOW + 60 * 86400000), capacity: 1, seats: [{ id: "seat", contactId: "reader", email: "reader@example.com", status: "active", consentedAt: new Date(NOW - 1000) }], ...extra });
const resolve = (contact, groups = []) => resolvePaidAccess({ contact, newsletter, groups, now: NOW });

test("higher group access preserves the independent personal subscription and falls back on revocation", () => {
	const contact = reader(), snapshot = structuredClone(contact);
	const joined = resolve(contact, [group()]);
	assert.equal(joined.access.source, "group"); assert.equal(joined.access.tierId, "premium"); assert.equal(joined.personal.subscriptionId, "sub_personal"); assert.equal(+joined.personal.until, +UNTIL); assert.deepEqual(contact, snapshot);
	const { set } = paidAccessUpdate(joined);
	const revoked = resolve({ ...contact, ...set }, [group({ subscriptionStatus: "canceled" })]);
	assert.equal(revoked.access.source, "personal"); assert.equal(revoked.access.tierId, "basic"); assert.equal(+revoked.access.paidUntil, +UNTIL); assert.equal(revoked.access.interval, "month");
});

test("a group projection cannot silently turn into a personal subscription when its seat expires", () => {
	const contact = reader({ paidSource: "group", paidPersonal: undefined });
	assert.equal(readPersonalAccess(contact), null);
	const result = resolve(contact, [group({ paidUntil: new Date(NOW) })]);
	assert.equal(result.access, null); assert.equal(paidAccessUpdate(result).set.tier, "free");
});

test("equal or lower group tiers do not replace an active personal plan, including lifetime access", () => {
	for (const contact of [reader({ paidTierId: "premium" }), reader({ paidTierId: "premium", paidInterval: "lifetime", paidUntil: new Date("2100-01-01") })]) {
		const result = resolve(contact, [group()]); assert.equal(result.access.source, "personal"); assert.equal(result.access.interval, contact.paidInterval);
	}
});

test("personal subscription and gift priority is preserved, with group fallback after personal access ends", () => {
	const grant = { kind: "gift", tierId: "basic", until: new Date(NOW + 40 * 86400000) };
	const contact = reader({ grant });
	assert.equal(resolve(contact).access.source, "personal");
	const inactive = reader({ grant, paidPersonal: { kind: "stripe", status: "past_due", tierId: "basic", until: UNTIL } });
	assert.equal(resolve(inactive).access.source, "grant");
	assert.equal(resolve(inactive, [group()]).access.source, "group");
	assert.equal(resolve(reader({ grant, paidPersonal: { kind: "stripe", status: "active", tierId: "basic", until: new Date(NOW - 4 * 86400000) } }), [group()]).access.source, "group");
});

test("legacy paid access remains finite and private group fields are removed on personal fallback", () => {
	const contact = reader({ stripeSubscriptionId: undefined, subscriptionStatus: undefined, paidInterval: undefined });
	assert.equal(readPersonalAccess(contact).kind, "legacy");
	assert.equal(+readPersonalAccess(contact).until, +UNTIL);
	const update = paidAccessUpdate(resolve(reader({ groupAccess: { groupId: "old" } })));
	assert.equal(update.unset.groupAccess, 1); assert.equal(update.set.paidSource, "personal");
	assert.equal(resolve(reader(), [group({ accountId: "other" }), group({ tierId: "unknown" })]).access.source, "personal");
});

test("revoking a driving grant cannot resurrect its projection as legacy personal access", () => {
	const result = resolve(reader({ paidSource: "grant", paidPersonal: undefined, grant: undefined }));
	assert.equal(result.personal, null); assert.equal(result.access, null);
});
