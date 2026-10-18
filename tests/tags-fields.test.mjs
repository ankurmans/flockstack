import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { castFilter } from "../lib/docdb/schema.js";
import { splitFilter } from "../lib/docdb/sql.js";
import { mapExtraColumns, normalizeImportRow, mapColumns } from "../lib/csv-import.js";
import { fillMergeTags, findMergeTags } from "../lib/merge-tags.js";
import { escapeHtml } from "../lib/render-email.js";
import { normalizeTag, parseTagList } from "../lib/tag-rules.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";
import { readClickToken } from "../lib/tracking.js";
import { parseFieldValue, slugifyFieldKey } from "../lib/custom-fields.js";
import { as, form } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;

before(async () => {
	t = await setupAudienceTests();
	t.m.archiveActions = await import("../app/archive/actions.js");
	t.m.exportRoute = await import("../app/api/v1/contacts/export.csv/route.js");
});

after(() => t?.app.stop());

describe("tags", () => {
	test("are lowercase, single spaced and limited to plain characters", () => {
		assert.equal(normalizeTag("  VIP   Customers "), "vip customers");
		assert.equal(normalizeTag("beta-2026_q1"), "beta-2026_q1");
		assert.equal(normalizeTag("café"), "café");
		for (const bad of ["", "   ", "<b>", "a".repeat(41), "-start", 12, null]) assert.equal(normalizeTag(bad), null, String(bad));
		assert.deepEqual(parseTagList("VIP, beta;Beta | <x>, "), ["vip", "beta"]);
	});

	test("are added, removed, listed with counts and deleted through the API", async () => {
		const user = await t.customer("tags-api@example.com");
		await t.importReaders(user, 3);
		const contacts = (await t.api(user.key, "GET", "/contacts")).body.contacts;
		const [first, second] = contacts;

		const added = await t.api(user.key, "POST", `/contacts/${first.id}/tags`, { tag: "  VIP " });
		assert.deepEqual({ tags: added.body.tags, changed: added.body.changed }, { tags: ["vip"], changed: true });
		const again = await t.api(user.key, "POST", `/contacts/${first.id}/tags`, { tag: "vip" });
		assert.equal(again.body.changed, false, "adding a tag twice changes nothing");
		await t.api(user.key, "POST", `/contacts/${second.id}/tags`, { tag: "vip" });
		await t.api(user.key, "POST", `/contacts/${second.id}/tags`, { tag: "beta" });
		t.assertError(await t.api(user.key, "POST", `/contacts/${first.id}/tags`, { tag: "<script>" }), 400, "validation_failed");

		assert.deepEqual((await t.api(user.key, "GET", "/tags")).body.tags, [
			{ name: "beta", contacts: 1 },
			{ name: "vip", contacts: 2 },
		]);
		const byTag = await t.api(user.key, "GET", "/contacts?tag=vip");
		assert.equal(byTag.body.contacts.length, 2);
		assert.equal(byTag.body.counts.active, 2, "counts follow the tag filter");
		assert.equal((await t.api(user.key, "GET", "/contacts?tag=beta")).body.contacts[0].id, second.id);
		assert.deepEqual((await t.api(user.key, "GET", `/contacts/${second.id}`)).body.tags.toSorted(), ["beta", "vip"]);

		const removed = await t.api(user.key, "DELETE", `/contacts/${second.id}/tags?tag=vip`);
		assert.deepEqual({ tags: removed.body.tags, changed: removed.body.changed }, { tags: ["beta"], changed: true });
		assert.equal((await t.api(user.key, "DELETE", `/contacts/${second.id}/tags?tag=vip`)).body.changed, false);

		const deleted = await t.api(user.key, "DELETE", "/tags?tag=vip");
		assert.deepEqual(deleted.body, { tag: "vip", contacts: 1 });
		assert.deepEqual((await t.api(user.key, "GET", "/tags")).body.tags, [{ name: "beta", contacts: 1 }]);
		t.assertError(await t.api(user.key, "DELETE", "/tags?tag=vip"), 404, "not_found");
	});

	test("a contact has up to 30 and tags stay inside their account", async () => {
		const user = await t.customer("tags-limit@example.com");
		await t.importReaders(user, 1);
		const [{ id }] = (await t.api(user.key, "GET", "/contacts")).body.contacts;
		for (let index = 0; index < 30; index++) assert.equal((await t.api(user.key, "POST", `/contacts/${id}/tags`, { tag: `tag ${index}` })).status, 200);
		assert.match(t.assertError(await t.api(user.key, "POST", `/contacts/${id}/tags`, { tag: "one more" }), 400, "validation_failed"), /up to 30/);

		const other = await t.customer("tags-other@example.com");
		assert.deepEqual((await t.api(other.key, "GET", "/tags")).body.tags, []);
		t.assertError(await t.api(other.key, "POST", `/contacts/${id}/tags`, { tag: "mine" }), 404, "not_found");
	});
});

describe("tags and fields in SQL", () => {
	let schema;

	before(async () => {
		schema = (await import("../models/Contact.js")).default.schema;
	});

	function split(filter) {
		return splitFilter(schema, castFilter(schema, filter));
	}

	test("filters on tags, field values and text run in the database", () => {
		for (const filter of [
			{ tags: "vip" },
			{ tags: { $ne: "vip" } },
			{ tags: { $in: ["a", "b"] } },
			{ tags: { $nin: ["a", "b"] } },
			{ tags: { $all: ["a", "b"] } },
			{ "fields.plan": "pro" },
			{ "fields.plan": { $ne: "pro" } },
			{ "fields.seats": { $gte: 5, $lt: 20 } },
			{ "fields.renews": { $exists: true } },
			{ "fields.company": { $regex: "acme" } },
			{ $or: [{ tags: "vip" }, { "fields.plan": "pro" }] },
		]) {
			const { hasResidual, where } = split(filter);
			assert.equal(hasResidual, false, JSON.stringify(filter));
			assert.ok(where, JSON.stringify(filter));
		}
	});

	test("answer like MongoDB would", async () => {
		const user = await t.customer("sql-semantics@example.com");
		const base = { accountId: user.accountId, newsletterId: user.newsletterId };
		await t.m.Contact.create({ ...base, email: "a@example.com", tags: ["vip", "beta"], fields: { plan: "pro", seats: 10, company: "Acme Inc", renews: "2026-12-01" } });
		await t.m.Contact.create({ ...base, email: "b@example.com", tags: ["beta"], fields: { plan: "free", seats: 2 } });
		await t.m.Contact.create({ ...base, email: "c@example.com" });
		const find = async (filter) => (await t.m.Contact.find({ accountId: user.accountId, ...filter }).sort({ email: 1 }).lean()).map(({ email }) => email[0]);

		assert.deepEqual(await find({ tags: "vip" }), ["a"]);
		assert.deepEqual(await find({ tags: { $ne: "vip" } }), ["b", "c"], "missing tags count as not having it");
		assert.deepEqual(await find({ tags: { $in: ["vip", "x"] } }), ["a"]);
		assert.deepEqual(await find({ tags: { $nin: ["vip"] } }), ["b", "c"]);
		assert.deepEqual(await find({ tags: { $all: ["vip", "beta"] } }), ["a"]);
		assert.deepEqual(await find({ "fields.plan": "free" }), ["b"]);
		assert.deepEqual(await find({ "fields.plan": { $ne: "free" } }), ["a", "c"]);
		assert.deepEqual(await find({ "fields.seats": { $gt: 5 } }), ["a"]);
		assert.deepEqual(await find({ "fields.renews": { $exists: false } }), ["b", "c"]);
		assert.deepEqual(await find({ "fields.company": { $regex: "cme" } }), ["a"]);
		assert.deepEqual(await find({ "fields.company": { $regex: "^Acme" } }), ["a"]);
		assert.deepEqual(await find({ "fields.company": { $regex: "Inc$" } }), ["a"]);
		assert.deepEqual(await find({ "fields.company": { $regex: "acme" } }), [], "case sensitive");
		assert.equal(await t.m.Contact.countDocuments({ accountId: user.accountId, tags: "beta" }), 2);
	});
});

describe("custom fields", () => {
	test("are defined per newsletter and set with values that fit their type", async () => {
		const user = await t.customer("fields-api@example.com");
		await t.importReaders(user, 1);
		const [{ id }] = (await t.api(user.key, "GET", "/contacts")).body.contacts;

		const name = await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		assert.equal(name.status, 201);
		assert.equal(name.body.key, "first_name");
		await t.api(user.key, "POST", "/custom-fields", { label: "Seats", type: "number" });
		await t.api(user.key, "POST", "/custom-fields", { label: "Renews", key: "renews_on", type: "date" });
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "First name again", key: "first_name", type: "text" }), 409, "conflict");
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "Email", type: "text" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "Bad", key: "Bad Key", type: "text" }), 400, "validation_failed");
		assert.deepEqual((await t.api(user.key, "GET", "/custom-fields")).body.fields.map(({ key }) => key), ["first_name", "seats", "renews_on"]);

		const set = await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "first_name", value: "  Jane " });
		assert.deepEqual(set.body.fields, { first_name: "Jane" });
		assert.deepEqual((await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "seats", value: 12 })).body.fields, { first_name: "Jane", seats: 12 });
		assert.equal((await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "renews_on", value: "2026-12-31T10:00:00Z" })).body.fields.renews_on, "2026-12-31");
		t.assertError(await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "seats", value: "many" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "renews_on", value: "2026-02-31" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "nope", value: "x" }), 400, "validation_failed");
		const cleared = await t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field: "seats", value: null });
		assert.deepEqual(cleared.body.fields, { first_name: "Jane", renews_on: "2026-12-31" });
		assert.deepEqual((await t.api(user.key, "GET", `/contacts/${id}`)).body.fields, { first_name: "Jane", renews_on: "2026-12-31" });

		const renamed = await t.api(user.key, "PATCH", "/custom-fields/first_name", { label: "Given name", onSignupForm: true });
		assert.deepEqual({ label: renamed.body.label, onSignupForm: renamed.body.onSignupForm, type: renamed.body.type }, { label: "Given name", onSignupForm: true, type: "text" });

		assert.deepEqual((await t.api(user.key, "DELETE", "/custom-fields/renews_on")).body, { key: "renews_on", deleted: true });
		assert.deepEqual((await t.api(user.key, "GET", `/contacts/${id}`)).body.fields, { first_name: "Jane" }, "its values go with it");
		t.assertError(await t.api(user.key, "DELETE", "/custom-fields/renews_on"), 404, "not_found");
	});

	test("values are parsed by type", () => {
		assert.deepEqual(parseFieldValue("number", "4.5"), { value: 4.5 });
		assert.deepEqual(parseFieldValue("number", ""), { value: null });
		assert.ok(parseFieldValue("number", "x").problem);
		assert.deepEqual(parseFieldValue("date", "2026-03-14"), { value: "2026-03-14" });
		assert.deepEqual(parseFieldValue("date", "2026-03-14T23:59:59Z"), { value: "2026-03-14" });
		assert.ok(parseFieldValue("date", "2026-13-01").problem);
		assert.ok(parseFieldValue("text", "x".repeat(501)).problem);
		assert.equal(slugifyFieldKey("  First name!  "), "first_name");
	});

	test("signups through the API carry tags and fields, new and existing contacts alike", async () => {
		const user = await t.customer("signup-fields@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		const created = await t.api(user.signupsKey, "POST", "/contacts", {
			email: "jane@signup-fields.example.org",
			tags: ["Website", "webinar"],
			fields: { first_name: "Jane" },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual(created.body.tags, ["website", "webinar"]);
		const again = await t.api(user.signupsKey, "POST", "/contacts", { email: "jane@signup-fields.example.org", tags: ["extra"], fields: { first_name: "Jane D." } });
		assert.equal(again.body.created, false);
		const stored = await t.api(user.key, "GET", `/contacts/${created.body.id}`);
		assert.deepEqual(stored.body.tags, ["website", "webinar", "extra"]);
		assert.deepEqual(stored.body.fields, { first_name: "Jane D." });

		t.assertError(await t.api(user.signupsKey, "POST", "/contacts", { email: "x@signup-fields.example.org", fields: { company: "Acme" } }), 400, "validation_failed");
		t.assertError(await t.api(user.signupsKey, "POST", "/contacts", { email: "y@signup-fields.example.org", tags: ["<b>"] }), 400, "validation_failed");
	});

	test("the signup form asks for the fields flagged for it, and never takes tags", async () => {
		const user = await t.customer("signup-form@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text", onSignupForm: true });
		await t.api(user.key, "POST", "/custom-fields", { label: "Internal note", type: "text" });
		await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent", sentAt: new Date() });
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });

		const submit = (fields) =>
			as({ jar: new Map(), ip: "203.0.113.50" }, () => t.m.archiveActions.subscribe(null, form({ newsletter: user.slug, email: "reader@signup-form.example.org", ...fields })));
		assert.deepEqual(await submit({ field_first_name: "Sam", field_internal_note: "hacked", tags: "customer" }), { ok: true });
		await flushAfter();
		const contact = await t.m.Contact.findOne({ accountId: user.accountId, email: "reader@signup-form.example.org" }).lean();
		assert.deepEqual(contact.fields, { first_name: "Sam" });
		assert.equal(contact.tags, undefined, "a visitor can't tag themselves");
	});
});

describe("importing and exporting", () => {
	test("reads a tags column and columns named like the newsletter's fields", () => {
		const headers = ["Email Address", "TAGS", "FNAME", "Plan", "Notes"];
		const definitions = [
			{ key: "first_name", label: "First name" },
			{ key: "plan", label: "Plan" },
		];
		const extra = mapExtraColumns(headers, definitions);
		assert.deepEqual(extra, { tags: "TAGS", fields: { first_name: "FNAME", plan: "Plan" } });
		const row = { "Email Address": "Jane@Example.com", TAGS: "VIP, Beta;beta", FNAME: " Jane ", Plan: "", Notes: "x" };
		const normalized = normalizeImportRow(row, mapColumns(headers), { extra: { tags: [extra.tags], fields: extra.fields } });
		assert.deepEqual({ tags: normalized.tags, fields: normalized.fields }, { tags: ["vip", "beta"], fields: { first_name: "Jane" } });
		assert.equal(normalizeImportRow(row, mapColumns(headers)).tags, undefined, "nothing extra unless asked");
	});

	test("tags and field values land on new and existing contacts, and the export gives them back", async () => {
		const user = await t.customer("import-extras@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		await t.api(user.key, "POST", "/custom-fields", { label: "Seats", type: "number" });
		await t.importReaders(user, 1, { prefix: "old" });
		const response = await t.api(user.key, "POST", "/contacts/import", {
			consent: true,
			tags: ["Imported 2026"],
			contacts: [
				{ email: `old0@${user.slug}.example.org`, tags: ["returning"], fields: { first_name: "Olga" } },
				{ email: `new@${user.slug}.example.org`, tags: ["vip", "<bad>"], fields: { first_name: "Nia", seats: "'-4", nope: "x", company: 1 } },
				{ email: `invalid-field@${user.slug}.example.org`, fields: { seats: "many" } },
			],
		});
		assert.equal(response.status, 200, JSON.stringify(response.body));
		assert.equal(response.body.created, 2);

		const byEmail = async (local) => (await t.m.Contact.findOne({ accountId: user.accountId, email: `${local}@${user.slug}.example.org` }).lean());
		assert.deepEqual((await byEmail("old0")).tags.toSorted(), ["imported 2026", "returning"]);
		assert.deepEqual((await byEmail("old0")).fields, { first_name: "Olga" });
		const created = await byEmail("new");
		assert.deepEqual(created.tags.toSorted(), ["imported 2026", "vip"]);
		assert.deepEqual(created.fields, { first_name: "Nia", seats: -4 }, "the export's quote before a minus sign goes");
		assert.equal((await byEmail("invalid-field")).fields, undefined);
		assert.deepEqual((await t.api(user.key, "GET", "/tags")).body.tags.map(({ name }) => name), ["imported 2026", "returning", "vip"]);

		const link = (await t.api(user.key, "GET", "/contacts/export")).body.url;
		const csv = await (await as({ jar: new Map() }, () => t.m.exportRoute.GET(new Request(link)))).text();
		const [header, ...lines] = csv.trim().split("\r\n");
		assert.match(header, /,tags,first_name,seats$/);
		const row = lines.find((line) => line.startsWith(`new@${user.slug}.example.org,`));
		assert.ok(row.endsWith(',"imported 2026, vip",Nia,\'-4') || row.endsWith(',"vip, imported 2026",Nia,\'-4'), row);
	});
});

describe("merge tags", () => {
	const newsletter = { _id: "74f1a2b3c4d5e6f7a8b9c0d2", name: "Notes", fromEmail: "jane@example.net", postalAddress: "1 Main St" };
	const reader = { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "reader@example.com", fields: { first_name: "Sam <b>", seats: 4 } };

	test("fill a field's value, or the fallback after the bar, and leave the email's own tags alone", () => {
		assert.equal(fillMergeTags("Hi {{first_name|there}}, {{company|your team}}!", { fields: { first_name: "Sam" } }), "Hi Sam, your team!");
		assert.equal(fillMergeTags("{{first_name}}|{{email}}", { email: "a@example.com" }), "|a@example.com");
		assert.equal(fillMergeTags("{{unsubscribe_url}} {{subject}} {{ first_name }}", {}), "{{unsubscribe_url}} {{subject}} {{ first_name }}");
		assert.equal(fillMergeTags("Hi {{first_name|friend}}", null), "Hi friend");
		assert.equal(fillMergeTags("{{first_name}}", { fields: { first_name: "<i>" } }, { escape: escapeHtml }), "&lt;i&gt;");
		assert.deepEqual(findMergeTags("{{first_name|x}} {{plan}} {{first_name}} {{unsubscribe_url}}"), ["first_name", "plan"]);
	});

	test("personalize the subject, the HTML (escaped) and the plain text of each recipient's email", () => {
		const campaign = {
			format: "markdown",
			subject: "{{first_name|Reader}}, your notes",
			previewText: "For {{first_name}}",
			markdown: "Hello {{first_name|there}}, you have {{seats}} seats. [Open](https://example.com/?who={{email}})",
		};
		const email = buildRecipientEmail({ campaign, newsletter, contact: reader, messageId: "84f1a2b3c4d5e6f7a8b9c0d3" });
		assert.equal(email.subject, "Sam <b>, your notes");
		assert.ok(email.html.includes("Hello Sam &lt;b&gt;, you have 4 seats."));
		assert.ok(!email.html.includes("{{"));
		assert.ok(email.text.includes("Hello Sam <b>, you have 4 seats."));
		const clickToken = /\/c\/([^"]+)"/.exec(email.html)[1];
		assert.equal(readClickToken(clickToken).url, "https://example.com/?who=reader%40example.com", "tags in a link's address are filled before it's tracked");

		const stranger = buildRecipientEmail({ campaign, newsletter, contact: { _id: reader._id, email: "x@example.com" } });
		assert.equal(stranger.subject, "Reader, your notes");
		assert.ok(stranger.html.includes("Hello there, you have  seats."));
	});
});

describe("a campaign with merge tags", () => {
	test("goes out personalized to each contact", async () => {
		const user = await t.customer("merge-send@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		await t.importReaders(user, 2, { fields: (index) => (index === 0 ? { first_name: "Ada" } : {}) });
		const id = await t.draft(user, { subject: "Hi {{first_name|friend}}", content: "Dear {{first_name|reader}}," });
		const before = sesEmails.length;
		assert.equal((await t.api(user.key, "POST", `/campaigns/${id}/send`)).status, 200);
		await t.runJobs();
		const mails = sesEmails.slice(before);
		assert.equal(mails.length, 2);
		const byTo = Object.fromEntries(mails.map((mail) => [mail.to, mail]));
		assert.equal(byTo[`reader0@${user.slug}.example.org`].subject, "Hi Ada");
		assert.ok(byTo[`reader0@${user.slug}.example.org`].html.includes("Dear Ada,"));
		assert.equal(byTo[`reader1@${user.slug}.example.org`].subject, "Hi friend");
		assert.ok(byTo[`reader1@${user.slug}.example.org`].text.includes("Dear reader,"));
	});
});
