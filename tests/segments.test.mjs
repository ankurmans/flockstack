import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { castFilter } from "../lib/docdb/schema.js";
import { splitFilter } from "../lib/docdb/sql.js";
import { checkRules, compileRules, describeRules } from "../lib/segment-rules.js";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;
const DAY_MS = 86_400_000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

before(async () => {
	t = await setupAudienceTests();
	t.m.scheduling = await import("../lib/scheduling.js");
});

after(() => t?.app.stop());

const FIELD_TYPES = new Map([
	["plan", "text"],
	["seats", "number"],
	["renews_on", "date"],
]);

describe("segment rules", () => {
	test("every condition compiles to a filter the database answers on its own", async () => {
		const Contact = (await import("../models/Contact.js")).default;
		const conditions = [
			{ type: "status", value: "active" },
			{ type: "status", op: "is_not", value: "bounced" },
			{ type: "tag", value: "vip" },
			{ type: "tag", op: "has_not", value: "vip" },
			{ type: "field", field: "plan", op: "eq", value: "pro" },
			{ type: "field", field: "plan", op: "neq", value: "pro" },
			{ type: "field", field: "plan", op: "contains", value: "pr.o" },
			{ type: "field", field: "plan", op: "starts_with", value: "pr" },
			{ type: "field", field: "seats", op: "gte", value: 5 },
			{ type: "field", field: "renews_on", op: "lt", value: "2026-12-01" },
			{ type: "field", field: "plan", op: "is_set" },
			{ type: "field", field: "plan", op: "is_not_set" },
			{ type: "signup_date", from: "2026-01-01", to: "2026-03-31" },
			{ type: "source", value: "website" },
			{ type: "engagement", kind: "opened", days: 30 },
			{ type: "engagement", kind: "clicked", days: 30 },
			{ type: "engagement", kind: "opened_or_clicked", days: 30 },
			{ type: "engagement", kind: "never_opened" },
			{ type: "engagement", kind: "dormant", days: 90 },
			{ type: "imported", value: true },
			{ type: "imported", value: false },
		];
		for (const match of ["all", "any"]) {
			const { rules, problem } = checkRules({ match, conditions: [...conditions, { match: match === "all" ? "any" : "all", conditions: conditions.slice(0, 5) }] }, FIELD_TYPES);
			assert.equal(problem, undefined);
			const filter = castFilter(Contact.schema, { accountId: "6650f1c2e9b1d4a012345678", ...compileRules(rules) });
			assert.equal(splitFilter(Contact.schema, filter).hasResidual, false, `${match}: nothing is left for JavaScript`);
		}
	});

	test("are checked against the newsletter's fields and stored in their final form", () => {
		const check = (conditions) => checkRules({ match: "all", conditions }, FIELD_TYPES);
		assert.match(check([{ type: "field", field: "nope", op: "eq", value: "x" }]).problem, /no custom field/);
		assert.match(check([{ type: "field", field: "seats", op: "eq", value: "many" }]).problem, /number/);
		assert.match(check([{ type: "field", field: "seats", op: "contains", value: "1" }]).problem, /text fields/);
		assert.match(check([{ type: "field", field: "plan", op: "eq" }]).problem, /value/);
		assert.match(check([{ type: "status", value: "gone" }]).problem, /one of/);
		assert.match(check([{ type: "tag", value: "<b>" }]).problem, /tag/);
		assert.match(check([{ type: "engagement", kind: "opened" }]).problem, /days/);
		assert.match(check([{ type: "signup_date" }]).problem, /from, to or both/);
		assert.match(check([{ type: "signup_date", from: "2026-05-01", to: "2026-04-01" }]).problem, /after/);
		assert.deepEqual(check([{ type: "tag", value: " VIP " }, { type: "field", field: "seats", op: "gt", value: "5" }, { type: "field", field: "renews_on", op: "eq", value: "2026-03-14T10:00:00Z" }]).rules, {
			match: "all",
			conditions: [
				{ type: "tag", op: "has", value: "vip" },
				{ type: "field", field: "seats", op: "gt", value: 5 },
				{ type: "field", field: "renews_on", op: "eq", value: "2026-03-14" },
			],
		});
	});

	test("read as words", () => {
		const { rules } = checkRules(
			{
				match: "all",
				conditions: [
					{ type: "status", value: "active" },
					{ match: "any", conditions: [{ type: "tag", value: "vip" }, { type: "engagement", kind: "opened", days: 30 }] },
				],
			},
			FIELD_TYPES
		);
		assert.equal(describeRules(rules), "Status is active and (Has the tag vip or opened in the last 30 days)");
	});
});

describe("segments over a list", () => {
	let user;
	const email = (name) => `${name}@${user.slug}.example.org`;
	const count = async (rules) => (await t.api(user.key, "POST", "/segments/preview", { rules })).body;

	before(async () => {
		user = await t.customer("segment-list@example.com");
		for (const field of [
			{ label: "Plan", type: "text" },
			{ label: "Seats", type: "number" },
			{ label: "Renews on", type: "date" },
		]) {
			await t.api(user.key, "POST", "/custom-fields", field);
		}
		const base = { accountId: user.accountId, newsletterId: user.newsletterId };
		const rows = [
			{ email: "ann", status: "active", tags: ["vip", "beta"], fields: { plan: "pro", seats: 12, renews_on: "2026-11-30" }, source: "website", subscribedAt: daysAgo(400), lastOpenAt: daysAgo(3), stats: { sent: 9, opens: 4, clicks: 0 } },
			{ email: "bob", status: "active", tags: ["beta"], fields: { plan: "free", seats: 1 }, source: "api", subscribedAt: daysAgo(200), lastClickAt: daysAgo(10), stats: { sent: 5, opens: 1, clicks: 1 } },
			{ email: "cat", status: "active", fields: { plan: "pro plus" }, source: "website", subscribedAt: daysAgo(150), stats: { sent: 6, opens: 0, clicks: 0 } },
			{ email: "dan", status: "active", source: "import", importId: "6650f1c2e9b1d4a012345678", subscribedAt: daysAgo(20) },
			{ email: "eve", status: "unsubscribed", tags: ["vip"], source: "website", subscribedAt: daysAgo(90) },
			{ email: "fay", status: "dormant", source: "website", subscribedAt: daysAgo(500), lastOpenAt: daysAgo(300), stats: { sent: 30, opens: 2, clicks: 0 } },
		];
		for (const row of rows) await t.m.Contact.create({ ...base, ...row, email: email(row.email) });
	});

	test("count contacts by status, tag, field, date, source, engagement and import", async () => {
		const who = async (rules) => (await t.api(user.key, "POST", "/segments/preview", { rules, sample: 25 })).body.sample.map((c) => c.email.split("@")[0]).sort();
		const all = (...conditions) => ({ match: "all", conditions });
		const any = (...conditions) => ({ match: "any", conditions });

		assert.deepEqual(await who(all({ type: "status", value: "active" })), ["ann", "bob", "cat", "dan"]);
		assert.deepEqual(await who(all({ type: "status", op: "is_not", value: "active" })), ["eve", "fay"]);
		assert.deepEqual(await who(all({ type: "tag", value: "vip" })), ["ann", "eve"]);
		assert.deepEqual(await who(all({ type: "tag", op: "has_not", value: "beta" })), ["cat", "dan", "eve", "fay"]);
		assert.deepEqual(await who(all({ type: "tag", value: "beta" }, { type: "tag", value: "vip" })), ["ann"]);
		assert.deepEqual(await who(any({ type: "tag", value: "vip" }, { type: "field", field: "plan", op: "eq", value: "free" })), ["ann", "bob", "eve"]);
		assert.deepEqual(await who(all({ type: "field", field: "plan", op: "contains", value: "pro" })), ["ann", "cat"]);
		assert.deepEqual(await who(all({ type: "field", field: "plan", op: "starts_with", value: "pro p" })), ["cat"]);
		assert.deepEqual(await who(all({ type: "field", field: "seats", op: "gt", value: 1 })), ["ann"]);
		assert.deepEqual(await who(all({ type: "field", field: "seats", op: "is_not_set" })), ["cat", "dan", "eve", "fay"]);
		assert.deepEqual(await who(all({ type: "field", field: "renews_on", op: "lte", value: "2026-11-30" })), ["ann"]);
		assert.deepEqual(await who(all({ type: "field", field: "plan", op: "neq", value: "pro" })), ["bob", "cat", "dan", "eve", "fay"]);
		assert.deepEqual(await who(all({ type: "signup_date", from: daysAgo(210).toISOString().slice(0, 10), to: daysAgo(100).toISOString().slice(0, 10) })), ["bob", "cat"]);
		assert.deepEqual(await who(all({ type: "signup_date", from: daysAgo(30).toISOString().slice(0, 10) })), ["dan"]);
		assert.deepEqual(await who(all({ type: "source", value: "website" })), ["ann", "cat", "eve", "fay"]);
		assert.deepEqual(await who(all({ type: "source", op: "is_not", value: "website" })), ["bob", "dan"]);
		assert.deepEqual(await who(all({ type: "engagement", kind: "opened", days: 7 })), ["ann"]);
		assert.deepEqual(await who(all({ type: "engagement", kind: "clicked", days: 30 })), ["bob"]);
		assert.deepEqual(await who(all({ type: "engagement", kind: "opened_or_clicked", days: 30 })), ["ann", "bob"]);
		assert.deepEqual(await who(all({ type: "engagement", kind: "never_opened" })), ["bob", "cat"]);
		assert.deepEqual(await who(all({ type: "engagement", kind: "dormant", days: 60 })), ["cat", "eve", "fay"]);
		assert.deepEqual(await who(all({ type: "imported", value: true })), ["dan"]);
		assert.deepEqual(await who(all({ type: "imported", value: false })), ["ann", "bob", "cat", "eve", "fay"]);
		assert.deepEqual(
			await who(all({ type: "status", value: "active" }, { match: "any", conditions: [{ type: "tag", value: "vip" }, { type: "engagement", kind: "clicked", days: 30 }] })),
			["ann", "bob"]
		);
	});

	test("live counts tell matching, active and sendable apart", async () => {
		await t.m.Suppression.create({ accountId: user.accountId, email: email("bob"), reason: "manual" });
		const preview = await count({ match: "all", conditions: [{ type: "tag", value: "beta" }] });
		assert.deepEqual({ matching: preview.matching, active: preview.active, sendable: preview.sendable }, { matching: 2, active: 2, sendable: 1 });
		await t.m.Suppression.deleteOne({ accountId: user.accountId, email: email("bob") });
	});

	test("are saved, listed with their counts, changed and deleted", async () => {
		const rules = { match: "all", conditions: [{ type: "tag", value: "beta" }] };
		const created = await t.api(user.key, "POST", "/segments", { name: "Beta readers", description: "Testing", rules });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual({ contacts: created.body.contacts, active: created.body.active, summary: created.body.summary }, { contacts: 2, active: 2, summary: "Has the tag beta" });
		t.assertError(await t.api(user.key, "POST", "/segments", { name: "Beta readers", rules }), 409, "conflict");
		t.assertError(await t.api(user.key, "POST", "/segments", { name: "Bad", rules: { match: "all", conditions: [{ type: "field", field: "nope", op: "is_set" }] } }), 400, "validation_failed");

		const listed = await t.api(user.key, "GET", "/segments");
		assert.deepEqual(listed.body.segments.map(({ name, contacts }) => [name, contacts]), [["Beta readers", 2]]);

		const updated = await t.api(user.key, "PATCH", `/segments/${created.body.id}`, {
			name: "Beta and VIP",
			rules: { match: "all", conditions: [{ type: "tag", value: "beta" }, { type: "tag", value: "vip" }] },
		});
		assert.deepEqual({ name: updated.body.name, contacts: updated.body.contacts }, { name: "Beta and VIP", contacts: 1 });
		assert.equal((await t.api(user.key, "PATCH", `/segments/${created.body.id}`, { description: null })).body.description, null);

		const detail = await t.api(user.key, "GET", `/segments/${created.body.id}`);
		assert.deepEqual(detail.body.preview.sample.map(({ email: address }) => address.split("@")[0]), ["ann"]);
		assert.equal((await t.api(user.key, "POST", "/segments/preview", { segment: "Beta and VIP" })).body.matching, 1, "by name");
		t.assertError(await t.api(user.key, "POST", "/segments/preview", {}), 400, "validation_failed");

		assert.deepEqual((await t.api(user.key, "DELETE", `/segments/${created.body.id}`)).body, { id: created.body.id, deleted: true });
		t.assertError(await t.api(user.key, "GET", `/segments/${created.body.id}`), 404, "not_found");
	});

	test("stay inside their account", async () => {
		const other = await t.customer("segment-other@example.com");
		const saved = await t.api(user.key, "POST", "/segments", { name: "Private", rules: { match: "all", conditions: [{ type: "status", value: "active" }] } });
		t.assertError(await t.api(other.key, "GET", `/segments/${saved.body.id}`), 404, "not_found");
		t.assertError(await t.api(other.key, "DELETE", `/segments/${saved.body.id}`), 404, "not_found");
		assert.deepEqual((await t.api(other.key, "GET", "/segments")).body.segments, []);
		assert.equal((await t.api(other.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "status", value: "active" }] } })).body.matching, 0);
		await t.api(user.key, "DELETE", `/segments/${saved.body.id}`);
	});
});

describe("a campaign sent to a segment", () => {
	async function setup(email) {
		const user = await t.customer(email);
		user.address = (name) => `${name}@${user.slug}.example.org`;
		return user;
	}
	const vipRules = { match: "all", conditions: [{ type: "tag", value: "vip" }] };
	const emailsTo = (user, before) => sesEmails.slice(before).map(({ to }) => to.split("@")[0]).sort();

	test("reaches only the segment's active contacts, and none who unsubscribed or were suppressed", async () => {
		const user = await setup("segment-send@example.com");
		await t.importReaders(user, 6, { tags: (index) => (index < 4 ? ["vip"] : []) });
		const contacts = (await t.api(user.key, "GET", "/contacts?limit=100")).body.contacts;
		const idOf = (name) => contacts.find(({ email }) => email.startsWith(`${name}@`)).id;
		await t.api(user.key, "PATCH", `/contacts/${idOf("reader1")}`, { status: "unsubscribed" });
		await t.m.Suppression.create({ accountId: user.accountId, email: user.address("reader2"), reason: "manual" });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;

		const id = await t.draft(user, { segment: segment.id });
		const detail = (await t.api(user.key, "GET", `/campaigns/${id}`)).body;
		assert.deepEqual({ segmentId: detail.segmentId, segment: detail.segment, audienceSize: detail.audienceSize, activeContacts: detail.activeContacts }, { segmentId: segment.id, segment: { id: segment.id, name: "VIPs" }, audienceSize: 2, activeContacts: 5 });

		const preview = (await t.api(user.key, "GET", `/campaigns/${id}/recipients`)).body;
		assert.deepEqual({ audience: preview.audience, recipients: preview.recipients, emails: preview.emails, fitsPlan: preview.fitsPlan, segment: preview.segment.name }, { audience: 2, recipients: 2, emails: 2, fitsPlan: true, segment: "VIPs" });
		assert.deepEqual(preview.sample.map(({ email }) => email.split("@")[0]).sort(), ["reader0", "reader3"]);
		assert.equal((await t.api(user.key, "GET", `/campaigns/${id}/recipients?audienceLimit=1`)).body.recipients, 1);

		const before = sesEmails.length;
		const sentCampaign = await t.api(user.key, "POST", `/campaigns/${id}/send`);
		assert.equal(sentCampaign.status, 200, JSON.stringify(sentCampaign.body));
		assert.equal(sentCampaign.body.stats.recipients, 2);
		await t.runJobs(user);
		assert.deepEqual(emailsTo(user, before), ["reader0", "reader3"]);
		const stored = await t.m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual(stored.segmentSnapshot, { name: "VIPs", rules: segment.rules });
	});

	test("is held to the same suppression check when its batch goes out", async () => {
		const user = await setup("segment-late-suppression@example.com");
		await t.importReaders(user, 3, { tags: () => ["vip"] });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		const id = await t.draft(user, { segment: segment.id });
		await t.api(user.key, "POST", `/campaigns/${id}/send`);
		await t.m.Suppression.create({ accountId: user.accountId, email: user.address("reader1"), reason: "complaint" });
		await t.m.Contact.updateOne({ accountId: user.accountId, email: user.address("reader2") }, { $set: { status: "unsubscribed" } });
		const before = sesEmails.length;
		await t.runJobs(user);
		assert.deepEqual(emailsTo(user, before), ["reader0"]);
		const messages = await t.m.Message.find({ accountId: user.accountId, campaignId: id }).lean();
		assert.deepEqual(messages.map(({ status }) => status).sort(), ["sent", "suppressed", "suppressed"]);
	});

	test("never mailed contacts go in the warm-up's first slice and the rest wait, as in any send", async () => {
		const user = await setup("segment-first-send@example.com");
		await t.importReaders(user, 300, { tags: () => ["vip"] });
		await t.importReaders(user, 100, { prefix: "outside" });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		const id = await t.draft(user, { segment: segment.id });
		const sent = await t.api(user.key, "POST", `/campaigns/${id}/send`);
		assert.equal(sent.body.stats.recipients, 300, "the segment, not the whole list");
		const stored = await t.m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.equal(stored.firstSend.slice, 200);
		assert.equal(stored.firstSend.held, 100);
		assert.equal(await t.m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "held" }), 100);
		assert.equal(await t.m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "queued" }), 200);
	});

	test("counts against the plan like any send", async () => {
		const user = await setup("segment-plan@example.com");
		await t.importReaders(user, 5, { tags: () => ["vip"] });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		await t.m.Account.updateOne({ _id: user.accountId }, { $set: { limitOverrides: { emailsPerMonth: 3 } } });
		const id = await t.draft(user, { segment: segment.id });
		const preview = (await t.api(user.key, "GET", `/campaigns/${id}/recipients`)).body;
		assert.deepEqual({ emails: preview.emails, emailsLeft: preview.emailsLeft, fitsPlan: preview.fitsPlan }, { emails: 5, emailsLeft: 3, fitsPlan: false });
		t.assertError(await t.api(user.key, "POST", `/campaigns/${id}/send`), 402, "plan_limit_emails");
	});

	test("is picked when it goes out, not when it was scheduled, and keeps its audience for the next steps", async () => {
		const user = await setup("segment-schedule@example.com");
		await t.importReaders(user, 4, { tags: (index) => (index === 0 ? ["vip"] : []) });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		const id = await t.draft(user, { segment: segment.id });
		const at = new Date(Date.now() + 2 * 3_600_000);
		assert.equal((await t.api(user.key, "POST", `/campaigns/${id}/schedule`, { scheduledAt: at.toISOString() })).status, 200);

		const contacts = (await t.api(user.key, "GET", "/contacts?limit=100")).body.contacts;
		await t.api(user.key, "POST", `/contacts/${contacts.find(({ email }) => email.startsWith("reader2@")).id}/tags`, { tag: "vip" });
		await t.m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
		const scheduledAt = (await t.m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).scheduledAt.toISOString();
		const before = sesEmails.length;
		const result = await t.m.scheduling.runScheduledSend({ accountId: String(user.accountId), campaignId: id, scheduledAt });
		assert.equal(result.started, true, JSON.stringify(result));
		await t.runJobs(user);
		assert.deepEqual(emailsTo(user, before), ["reader0", "reader2"]);

		await t.api(user.key, "PATCH", `/segments/${segment.id}`, { rules: { match: "all", conditions: [{ type: "status", value: "active" }] } });
		const more = await t.api(user.key, "POST", `/campaigns/${id}/send-more`, {});
		assert.equal(more.status, 422, "everyone in the audience it went to has it already");
		assert.equal(more.body.error.code, "no_recipients");
	});

	test("can't go to a segment that a campaign still uses, nor one from another newsletter", async () => {
		const user = await setup("segment-in-use@example.com");
		await t.importReaders(user, 1, { tags: () => ["vip"] });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		const id = await t.draft(user, { segment: segment.id });
		t.assertError(await t.api(user.key, "DELETE", `/segments/${segment.id}`), 409, "conflict");
		t.assertError(await t.api(user.key, "PATCH", `/campaigns/${id}`, { segment: "6650f1c2e9b1d4a012345678" }), 404, "not_found");
		assert.equal((await t.api(user.key, "PATCH", `/campaigns/${id}`, { segment: null })).body.segmentId, null);
		assert.equal((await t.api(user.key, "DELETE", `/segments/${segment.id}`)).status, 200);

		const other = await setup("segment-foreign@example.com");
		t.assertError(await t.api(other.key, "PATCH", `/campaigns/${await t.draft(other)}`, { segment: segment.id }), 404, "not_found");
	});

	test("with the list cleanup on, cold contacts of the segment get the last-chance email instead, as in any send", async () => {
		const user = await setup("segment-cleanup@example.com");
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "cleanup.enabled": true, "cleanup.issues": 2, "cleanup.days": 30 } });
		await t.importReaders(user, 3, { tags: () => ["vip"] });
		await t.m.Contact.updateOne(
			{ accountId: user.accountId, email: user.address("reader0") },
			{ $set: { ignoredIssues: 5, subscribedAt: daysAgo(200), lastEngagedAt: daysAgo(200) } }
		);
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: vipRules })).body;
		const id = await t.draft(user, { segment: segment.id });
		const preview = (await t.api(user.key, "GET", `/campaigns/${id}/recipients`)).body;
		assert.deepEqual({ audience: preview.audience, recipients: preview.recipients, lastChance: preview.lastChance, emails: preview.emails }, { audience: 3, recipients: 2, lastChance: 1, emails: 3 });
		const before = sesEmails.length;
		await t.api(user.key, "POST", `/campaigns/${id}/send`);
		await t.runJobs(user);
		const mails = sesEmails.slice(before);
		assert.equal(mails.length, 3);
		assert.equal(mails.filter(({ subject }) => subject === "Issue").length, 2);
		assert.equal(await t.m.Message.countDocuments({ accountId: user.accountId, campaignId: id, kind: "last-chance" }), 1);
	});
});

