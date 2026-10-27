import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { anonymous, as, callApi, form, startTestApp } from "./helpers/app.mjs";
import { api, installFakeStripe } from "./helpers/shop.mjs";
import { fundedGroup, groupModels, invite } from "./helpers/groups.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = await groupModels(); });
after(() => app?.stop());

test("group actions have schema-valid output, private DTOs and real scoped invoice reads", async () => {
	const s = await fundedGroup(m, fake);
	const settings = await api(s.user, "GET", `/newsletters/${s.user.newsletterId}/groups/settings`); assert.equal(settings.status, 200); assert.equal(settings.body.enabled, true);
	const groups = await api(s.user, "GET", `/groups?newsletter=${s.user.slug}&limit=1`); assert.equal(groups.status, 200); assert.equal(groups.body.groups.length, 1);
	const detail = await api(s.user, "GET", `/groups/${s.group._id}`); assert.equal(detail.status, 200);
	assert.doesNotMatch(JSON.stringify(detail.body), /billingLease|managerVersion|stripeCustomerId|stripeSessionId|token|invitationVersion/);
	const invoices = await api(s.user, "GET", `/groups/${s.group._id}/invoices`); assert.equal(invoices.status, 200); assert.equal(invoices.body.invoices[0].amountPaidMinor, 3200);
	const refreshed = await api(s.user, "POST", `/groups/${s.group._id}/refresh`, {}); assert.equal(refreshed.status, 200); assert.equal(refreshed.body.capacity, 2);
	const other = await fundedGroup(m, fake);
	assert.equal((await api(other.user, "GET", `/groups/${s.group._id}`)).status, 404);
});

test("restricted agent keys cannot manage another newsletter's group or send seat email without approval", async () => {
	const s = await fundedGroup(m, fake), other = await fundedGroup(m, fake);
	const keys = await import("../app/(app)/api-keys/actions.js");
	const read = (await as(s.user, () => keys.createApiKey(null, form({ name: "Group reader", level: "read_only", newsletter: String(s.user.newsletterId) })))).key;
	const reader = { ...s.user, key: read };
	assert.equal((await api(reader, "GET", `/groups/${s.group._id}`)).status, 200);
	assert.equal((await api(reader, "GET", `/groups/${s.group._id}/invoices`)).status, 403);
	assert.equal((await api(reader, "POST", `/groups/${s.group._id}/seats`, { email: "blocked@example.com" })).status, 403);
	assert.equal((await api(reader, "GET", `/groups/${other.group._id}`)).status, 403);
	const approving = (await as(s.user, () => keys.createApiKey(null, form({ name: "Group sender", level: "send_with_approval", newsletter: String(s.user.newsletterId) })))).key;
	const result = await callApi("POST", `/api/v1/groups/${s.group._id}/seats`, { key: approving, body: { email: "approval@example.com" } });
	assert.equal(result.status, 202); assert.equal(result.body.status, "approval_required");
	assert.equal((await m.groups.findGroup(s.user.account, s.group._id)).seats.length, 0);
});

test("financial reporting counts group subscriptions and its explicit refresh includes group source rows", async () => {
	const s = await fundedGroup(m, fake);
	const report = await api(s.user, "GET", `/reports/revenue?newsletter=${s.user.slug}`);
	assert.equal(report.status, 200); assert.equal(report.body.coverage.untrackedSubscriptions, 0); assert.equal(report.body.coverage.observedSubscriptions, 1);
	assert.equal(report.body.currencies[0].knownGrossMonthlyPriceMinor, 3200);
	const refresh = await api(s.user, "POST", "/reports/revenue/refresh", { newsletter: s.user.slug });
	assert.equal(refresh.status, 200); assert.equal(refresh.body.contactsScanned, 0); assert.equal(refresh.body.groupsScanned, 1); assert.equal(refresh.body.subscriptionsObserved, 1);
});

test("a group checkout reserves its tier and cannot import its buyer as an individual reader", async () => {
	const s = await fundedGroup(m, fake);
	const { hasTierHolders } = await import("../lib/paid-tiers.js");
	assert.equal(await hasTierHolders(s.user.account, s.user.newsletter, "premium"), true);
	const removed = await api(s.user, "DELETE", `/newsletters/${s.user.newsletterId}/tiers/premium`); assert.equal(removed.status, 409);
	const subscriptionId = `sub_group${s.group._id}`, priceId = "price_group";
	fake.subscriptions.set(subscriptionId, { ...s.subscription, id: subscriptionId });
	await m.Group.updateOne({ accountId: s.user.accountId, _id: s.group._id }, { $set: { stripeSubscriptionId: subscriptionId } });
	const imported = await api(s.user, "POST", "/payments/import-subscribers", { newsletter: s.user.slug, subscriptions: [subscriptionId], prices: { [priceId]: "premium" }, apply: true, consent: true });
	assert.equal(imported.status, 200); assert.equal(imported.body.rows[0].status, "failed"); assert.match(imported.body.rows[0].error, /individual reader/);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
});

test("public forms authorize their scoped capability on each call and GET never accepts a seat", async () => {
	const s = await fundedGroup(m, fake), invitation = await invite(m, s, "public-form@example.com");
	const page = (await import("../app/reader/groups/[screen]/page.js")).default;
	const actions = await import("../app/reader/groups/actions.js");
	await page({ params: Promise.resolve({ screen: "invite" }), searchParams: Promise.resolve({ token: invitation.token }) });
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	const rejected = await anonymous(() => actions.acceptSeat(null, form({ token: invitation.token, email: invitation.seat.email }))); assert.ok(rejected.error);
	const accepted = await anonymous(() => actions.acceptSeat(null, form({ token: invitation.token, email: invitation.seat.email, subscribe: "on" }))); assert.equal(accepted.ok, true, accepted.error); assert.equal(new URL(accepted.continueUrl).pathname, "/reader/in");
	const token = new URL(m.links.getGroupManagerLink(await m.groups.findGroup(s.user.account, s.group._id))).searchParams.get("token");
	const invoices = await anonymous(() => actions.manageGroup(null, form({ token, operation: "invoices" }))); assert.equal(invoices.invoices.length, 1);
	const wrong = await anonymous(() => actions.manageGroup(null, form({ token: invitation.token, operation: "invoices" }))); assert.ok(wrong.error);
	const before = fake.requests.length;
	await page({ params: Promise.resolve({ screen: "complete" }), searchParams: Promise.resolve({ newsletter: s.user.slug, session_id: s.group.stripeSessionId }) });
	assert.equal(fake.requests.length, before, "public completion never fulfills or exposes billing from a session ID");
});
