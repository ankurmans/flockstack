import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { castFilter } from "../lib/docdb/schema.js";
import { splitFilter } from "../lib/docdb/sql.js";
import { LOOKUP_CHUNK, checkRules, collectLookups, compileRules, describeRules, lookupKey } from "../lib/segment-rules.js";
import { getHeaderCountry, readCountry } from "../lib/signup-country.js";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { form } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;
const DAY_MS = 86_400_000;
const ID = (n) => `6650f1c2e9b1d4a0123456${String(n).padStart(2, "0")}`;

before(async () => {
	t = await setupAudienceTests();
	t.m.snapshots = await import("../lib/segment-snapshots.js");
	t.m.snapshotRoute = await import("../app/api/jobs/snapshot-segment/route.js");
	t.m.archive = await import("../app/archive/actions.js");
	t.m.Newsletter = (await import("../models/Newsletter.js")).default;
	t.m.CampaignLink = (await import("../models/CampaignLink.js")).default;
	t.m.SegmentMember = (await import("../models/SegmentMember.js")).default;
	t.m.Segment = (await import("../models/Segment.js")).default;
});

after(() => t?.app.stop());

const FIELD_TYPES = new Map([
	["plan", "text"],
	["seats", "number"],
	["topics", { type: "list", options: ["news", "tips", "ads"], multiple: true }],
]);

describe("the new conditions", () => {
	test("are checked, stored in their final form and read as words", () => {
		const check = (conditions, match = "all") => checkRules({ match, conditions }, FIELD_TYPES);
		const { rules, problem } = check([
			{ type: "tier", value: "paid" },
			{ type: "country", op: "is_any_of", values: ["us", " de "] },
			{ type: "referrals", op: "gte", value: 3 },
			{ type: "source", op: "is_none_of", values: ["api", "import"] },
			{ type: "status", op: "is_any_of", values: ["active", "pending"] },
			{ type: "tag", op: "is_none_of", values: ["Beta", "alpha"] },
			{ type: "field", field: "plan", op: "is_any_of", values: ["pro", "team"] },
			{ type: "field", field: "topics", op: "is_none_of", values: ["ads"] },
			{ type: "poll", poll: ID(1), op: "is_any_of", options: [2, 0, 2] },
			{ type: "issue", campaign: ID(2), action: "clicked", url: " https://example.com/a " },
			{ type: "snapshot", segment: ID(3) },
		]);
		assert.equal(problem, undefined);
		assert.deepEqual(rules.conditions.slice(0, 9), [
			{ type: "tier", op: "is", value: "paid" },
			{ type: "country", op: "is_any_of", values: ["US", "DE"] },
			{ type: "referrals", op: "gte", value: 3 },
			{ type: "source", op: "is_none_of", values: ["api", "import"] },
			{ type: "status", op: "is_any_of", values: ["active", "pending"] },
			{ type: "tag", op: "is_none_of", values: ["beta", "alpha"] },
			{ type: "field", field: "plan", op: "is_any_of", values: ["pro", "team"] },
			{ type: "field", field: "topics", op: "is_none_of", values: ["ads"] },
			{ type: "poll", poll: ID(1), op: "is_any_of", options: [0, 2] },
		]);
		assert.equal(
			describeRules({ match: "all", conditions: rules.conditions.slice(0, 4) }),
			"Is a paid subscriber and Country is any of US, DE and Referrals is at least 3 and Source is none of api, import"
		);

		assert.match(check([{ type: "tier", value: "gold" }]).problem, /free, paid/);
		assert.match(check([{ type: "country", value: "USA" }]).problem, /two-letter/);
		assert.match(check([{ type: "country", op: "is_any_of" }]).problem, /values/);
		assert.match(check([{ type: "country", op: "is_any_of", values: [] }]).problem, /1 to 25/);
		assert.match(check([{ type: "referrals", op: "gte", value: -1 }]).problem, /0 or more/);
		assert.match(check([{ type: "referrals", op: "lt", value: 0 }]).problem, /fewer than 0/);
		assert.match(check([{ type: "field", field: "seats", op: "contains", value: "1" }]).problem, /text fields/);
		assert.match(check([{ type: "field", field: "seats", op: "is_any_of", values: ["many"] }]).problem, /number/);
		assert.match(check([{ type: "issue", campaign: "nope", action: "opened" }]).problem, /issue's ID/);
		assert.match(check([{ type: "issue", campaign: ID(2), action: "opened", link: 1 }]).problem, /clicked and not_clicked/);
		assert.match(check([{ type: "issue", campaign: ID(2), action: "clicked", link: 1, url: "https://example.com" }]).problem, /link or url, not both/);
		assert.match(check([{ type: "snapshot", segment: "x" }]).problem, /saved list/);
		assert.match(check(Array.from({ length: 6 }, (_, n) => ({ type: "issue", campaign: ID(n + 10), action: "opened" }))).problem, /up to 5 conditions on an issue/);
		assert.match(check(Array.from({ length: 41 }, () => ({ type: "tier", value: "paid" }))).problem, /up to 40 conditions/);
	});

	test("every one compiles to a filter the database answers on its own", async () => {
		const Contact = (await import("../models/Contact.js")).default;
		const conditions = [
			{ type: "tier", value: "paid" },
			{ type: "tier", op: "is_not", value: "paid" },
			{ type: "country", value: "US" },
			{ type: "country", op: "is_not", value: "US" },
			{ type: "country", op: "is_any_of", values: ["US", "DE"] },
			{ type: "country", op: "is_none_of", values: ["US", "DE"] },
			...["eq", "neq", "gt", "gte", "lt", "lte"].map((op) => ({ type: "referrals", op, value: 2 })),
			{ type: "referrals", op: "eq", value: 0 },
			{ type: "referrals", op: "neq", value: 0 },
			{ type: "referrals", op: "gte", value: 0 },
			{ type: "source", op: "is_any_of", values: ["website"] },
			{ type: "status", op: "is_none_of", values: ["bounced"] },
			{ type: "tag", op: "is_any_of", values: ["vip", "beta"] },
			{ type: "tag", op: "is_none_of", values: ["vip", "beta"] },
			{ type: "field", field: "plan", op: "is_any_of", values: ["pro"] },
			{ type: "field", field: "plan", op: "is_none_of", values: ["pro"] },
			{ type: "field", field: "topics", op: "is_any_of", values: ["news", "tips"] },
			{ type: "field", field: "topics", op: "is_none_of", values: ["news"] },
			{ type: "poll", poll: ID(1), op: "is_any_of", options: [0, 1] },
			{ type: "poll", poll: ID(1), op: "is_none_of", options: [0] },
			{ type: "issue", campaign: ID(2), action: "opened" },
			{ type: "issue", campaign: ID(2), action: "not_clicked", link: 0 },
			{ type: "snapshot", segment: ID(3) },
		];
		const { rules, problem } = checkRules({ match: "any", conditions }, FIELD_TYPES);
		assert.equal(problem, undefined);
		const lookups = new Map(collectLookups(rules).map(({ key }) => [key, [ID(40), ID(41)]]));
		const filter = castFilter(Contact.schema, { accountId: ID(99), ...compileRules(rules, new Date(), lookups) });
		assert.equal(splitFilter(Contact.schema, filter).hasResidual, false, "nothing is left for JavaScript");
		assert.throws(() => compileRules(rules), /looked up first/);
	});

	test("a lookup is split into parameters that fit D1's strings, and an empty one matches nobody", () => {
		const { rules } = checkRules({ match: "all", conditions: [{ type: "issue", campaign: ID(2), action: "opened" }] }, FIELD_TYPES);
		const key = lookupKey(rules.conditions[0]);
		const ids = Array.from({ length: LOOKUP_CHUNK * 2 + 5 }, (_, index) => String(index));
		const filter = compileRules(rules, new Date(), new Map([[key, ids]]));
		assert.equal(filter.$and[0].$or.length, 3);
		assert.deepEqual(compileRules(rules, new Date(), new Map([[key, []]])), { $and: [{ _id: { $in: [] } }] });
	});
});

describe("country", () => {
	test("reads Cloudflare's header, and nothing it can't place", () => {
		assert.equal(readCountry(" de "), "DE");
		for (const value of ["XX", "T1", "USA", "", null, undefined, "1a"]) assert.equal(readCountry(value), null, String(value));
		assert.equal(getHeaderCountry(new Headers({ "cf-ipcountry": "FR" })), "FR");
		assert.equal(getHeaderCountry(new Headers()), null);
	});

	test("is kept at signup on the website and through the API, once, and is a segment condition", async () => {
		const user = await t.customer("seg2-country@example.com");
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
		const join = (email, country) =>
			runWithRequest({ headers: { "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 250) + 1}`, ...(country && { "cf-ipcountry": country }) } }, () =>
				t.m.archive.subscribe(null, form({ newsletter: user.slug, email }))
			);
		const address = (name) => `${name}@${user.slug}.example.org`;
		assert.equal((await join(address("fr"), "FR")).ok, true);
		await join(address("fr2"), "FR");
		await join(address("nowhere"), "XX");
		await join(address("plain"), null);
		const api = await t.api(user.signupsKey, "POST", "/contacts", { email: address("api-de"), country: "de" });
		assert.equal(api.status, 201, JSON.stringify(api.body));
		const stored = async (name) => (await t.m.Contact.findOne({ accountId: user.accountId, email: address(name) }).lean()).country;
		assert.deepEqual([await stored("fr"), await stored("fr2"), await stored("nowhere"), await stored("plain"), await stored("api-de")], ["FR", "FR", undefined, undefined, "DE"]);

		// A contact with none yet gets it at the next signup, and one that has it keeps it.
		await join(address("plain"), "ES");
		await join(address("fr"), "ES");
		assert.deepEqual([await stored("plain"), await stored("fr")], ["ES", "FR"]);

		const contact = (await t.api(user.key, "GET", "/contacts?limit=100")).body.contacts.find(({ email }) => email === address("fr"));
		assert.equal(contact.country, "FR");
		const count = async (conditions) => (await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions } })).body.matching;
		assert.equal(await count([{ type: "country", value: "fr" }]), 2);
		assert.equal(await count([{ type: "country", op: "is_any_of", values: ["FR", "DE"] }]), 3);
		assert.equal(await count([{ type: "country", op: "is_none_of", values: ["FR", "DE"] }]), 2, "contacts with no country are in none of them");
	});
});

describe("segments over a list", () => {
	let user;
	let pollId;
	let campaignId;
	const email = (name) => `${name}@${user.slug}.example.org`;
	const names = async (conditions, match = "all") => {
		const response = await t.api(user.key, "POST", "/segments/preview", { rules: { match, conditions }, sample: 25 });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		return response.body.sample.map((contact) => contact.email.split("@")[0]).sort();
	};

	before(async () => {
		user = await t.customer("seg2-list@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
		await t.api(user.key, "POST", "/custom-fields", { label: "Topics", type: "list", options: ["news", "tips", "ads"], multiple: true });
		pollId = (await t.api(user.key, "POST", "/polls", { question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] })).body?.id;
		const base = { accountId: user.accountId, newsletterId: user.newsletterId };
		const future = new Date(Date.now() + 20 * DAY_MS);
		const rows = [
			{ email: "ann", status: "active", country: "US", tier: "paid", paidUntil: future, referral: { count: 3 }, source: "website", tags: ["vip"], fields: { plan: "pro", topics: ["news", "tips"] }, polls: pollId && { [`p${pollId}`]: 0 } },
			{ email: "bob", status: "active", country: "DE", source: "api", tags: ["beta"], fields: { plan: "team", topics: ["ads"] }, polls: pollId && { [`p${pollId}`]: 2 } },
			{ email: "cat", status: "active", country: "FR", referral: { count: 1 }, source: "website", tags: ["vip", "beta"], fields: { plan: "free" } },
			{ email: "dan", status: "active", source: "import" },
			{ email: "eve", status: "unsubscribed", country: "US", tier: "paid", paidUntil: new Date(Date.now() - 30 * DAY_MS), source: "website" },
		];
		for (const row of rows) await t.m.Contact.create({ ...base, ...row, email: email(row.email) });
	});

	test("filter by tier, country, referrals and source, with any of and none of", async () => {
		assert.deepEqual(await names([{ type: "tier", value: "paid" }]), ["ann"], "a paid reader whose period ran out is free");
		assert.deepEqual(await names([{ type: "tier", op: "is_not", value: "paid" }]), ["bob", "cat", "dan", "eve"]);
		assert.deepEqual(await names([{ type: "country", op: "is_any_of", values: ["US", "DE"] }]), ["ann", "bob", "eve"]);
		assert.deepEqual(await names([{ type: "country", op: "is_none_of", values: ["US", "DE"] }]), ["cat", "dan"]);
		assert.deepEqual(await names([{ type: "referrals", op: "gte", value: 1 }]), ["ann", "cat"]);
		assert.deepEqual(await names([{ type: "referrals", op: "gte", value: 2 }]), ["ann"]);
		assert.deepEqual(await names([{ type: "referrals", op: "eq", value: 0 }]), ["bob", "dan", "eve"], "no credits is zero");
		assert.deepEqual(await names([{ type: "referrals", op: "lt", value: 2 }]), ["bob", "cat", "dan", "eve"]);
		assert.deepEqual(await names([{ type: "referrals", op: "neq", value: 0 }]), ["ann", "cat"]);
		assert.deepEqual(await names([{ type: "referrals", op: "neq", value: 3 }]), ["bob", "cat", "dan", "eve"]);
		assert.deepEqual(await names([{ type: "source", op: "is_any_of", values: ["api", "import"] }]), ["bob", "dan"]);
		assert.deepEqual(await names([{ type: "source", op: "is_none_of", values: ["api", "import"] }]), ["ann", "cat", "eve"]);
		assert.deepEqual(await names([{ type: "status", op: "is_none_of", values: ["unsubscribed", "bounced"] }]), ["ann", "bob", "cat", "dan"]);
		assert.deepEqual(await names([{ type: "tag", op: "is_any_of", values: ["vip", "beta"] }]), ["ann", "bob", "cat"]);
		assert.deepEqual(await names([{ type: "tag", op: "is_none_of", values: ["vip"] }]), ["bob", "dan", "eve"]);
		assert.deepEqual(await names([{ type: "field", field: "plan", op: "is_any_of", values: ["pro", "free"] }]), ["ann", "cat"]);
		assert.deepEqual(await names([{ type: "field", field: "plan", op: "is_none_of", values: ["pro", "free"] }]), ["bob", "dan", "eve"]);
		assert.deepEqual(await names([{ type: "field", field: "topics", op: "is_any_of", values: ["tips", "ads"] }]), ["ann", "bob"], "a list field holding several options");
		assert.deepEqual(await names([{ type: "field", field: "topics", op: "is_none_of", values: ["news"] }]), ["bob", "cat", "dan", "eve"]);
	});

	test("nest: all of a group of any of, with the new conditions inside", async () => {
		const rules = [
			{ type: "status", value: "active" },
			{ match: "any", conditions: [{ type: "tier", value: "paid" }, { type: "referrals", op: "gte", value: 1 }, { type: "country", value: "DE" }] },
		];
		assert.deepEqual(await names(rules), ["ann", "bob", "cat"]);
	});

	test("filter by a poll's answers", async (context) => {
		if (!pollId) return context.skip("polls aren't open to this key");
		assert.deepEqual(await names([{ type: "poll", poll: pollId, op: "is_any_of", options: [0, 1] }]), ["ann"]);
		assert.deepEqual(await names([{ type: "poll", poll: pollId, op: "is_none_of", options: [0] }]), ["bob", "cat", "dan", "eve"]);
		const saved = await t.api(user.key, "POST", "/segments", { name: "A or B", rules: { match: "all", conditions: [{ type: "poll", poll: pollId, op: "is_any_of", options: [0, 1] }] } });
		assert.match(saved.body.summary, /Answered any of "A", "B" in the poll "Which\?"/);
		t.assertError(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "poll", poll: pollId, op: "is_any_of", options: [7] }] } }), 400, "validation_failed");
	});

	describe("who opened or clicked an issue", () => {
		before(async () => {
			const base = { accountId: user.accountId, newsletterId: user.newsletterId };
			const campaign = await t.m.Campaign.create({ ...base, subject: "Issue one", status: "sent", sentAt: new Date() });
			campaignId = String(campaign._id);
			await t.m.CampaignLink.create({ accountId: user.accountId, campaignId: campaign._id, index: 0, url: "https://example.com/a" });
			await t.m.CampaignLink.create({ accountId: user.accountId, campaignId: campaign._id, index: 1, url: "https://example.com/b" });
			await t.m.CampaignLink.create({ accountId: user.accountId, campaignId: campaign._id, index: 2, url: "https://example.com/a" });
			const contacts = new Map((await t.m.Contact.find({ accountId: user.accountId }).lean()).map((contact) => [contact.email.split("@")[0], contact]));
			const message = (name, extra) =>
				t.m.Message.create({ ...base, kind: "campaign", campaignId: campaign._id, contactId: contacts.get(name)._id, email: email(name), status: "delivered", sentAt: new Date(), ...extra });
			await message("ann", { openedAt: new Date(), clickedAt: new Date(), clickedLinks: [0] });
			await message("bob", { openedAt: new Date() });
			await message("cat", {});
			await message("eve", { openedAt: new Date(), status: "delivered" });
		});

		test("opened, clicked, and got it but didn't", async () => {
			const issue = (action, extra = {}) => ({ type: "issue", campaign: campaignId, action, ...extra });
			assert.deepEqual(await names([issue("opened")]), ["ann", "bob", "eve"]);
			assert.deepEqual(await names([issue("clicked")]), ["ann"]);
			assert.deepEqual(await names([issue("not_opened")]), ["cat"], "dan never got it");
			assert.deepEqual(await names([issue("not_clicked")]), ["bob", "cat", "eve"]);
		});

		test("clicked a given link, by its place or its address, and didn't", async () => {
			const issue = (action, extra = {}) => ({ type: "issue", campaign: campaignId, action, ...extra });
			assert.deepEqual(await names([issue("clicked", { link: 0 })]), ["ann"]);
			assert.deepEqual(await names([issue("clicked", { link: 1 })]), []);
			assert.deepEqual(await names([issue("clicked", { url: "https://example.com/a" })]), ["ann"], "the address leads to every place it has");
			assert.deepEqual(await names([issue("not_clicked", { link: 0 })]), ["bob", "cat", "eve"]);
			assert.deepEqual(await names([issue("not_clicked", { url: "https://example.com/b" })]), ["ann", "bob", "cat", "eve"]);
			const saved = await t.api(user.key, "POST", "/segments", { name: "Clicked a", rules: { match: "all", conditions: [issue("clicked", { url: "https://example.com/a" })] } });
			assert.equal(saved.status, 201, JSON.stringify(saved.body));
			assert.deepEqual(saved.body.rules.conditions[0], { type: "issue", campaign: campaignId, action: "clicked", url: "https://example.com/a", links: [0, 2], subject: "Issue one" });
			assert.equal(saved.body.summary, 'Clicked the link https://example.com/a in "Issue one"');
			assert.equal(saved.body.contacts, 1);
		});

		test("combine with other conditions, and refuse an issue or a link that isn't there", async () => {
			const issue = { type: "issue", campaign: campaignId, action: "opened" };
			assert.deepEqual(await names([issue, { type: "status", value: "active" }, { type: "tag", op: "is_none_of", values: ["beta"] }]), ["ann"]);
			assert.deepEqual(await names([{ type: "status", value: "active" }, { match: "any", conditions: [issue, { type: "country", value: "FR" }] }]), ["ann", "bob", "cat"]);
			const refuse = async (condition) => t.assertError(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [condition] } }), 400, "validation_failed");
			assert.match(await refuse({ ...issue, campaign: ID(77) }), /no issue/);
			assert.match(await refuse({ type: "issue", campaign: campaignId, action: "clicked", link: 9 }), /no link 9/);
			assert.match(await refuse({ type: "issue", campaign: campaignId, action: "clicked", url: "https://example.com/nope" }), /no link with that address/);
		});

		test("an issue's readers can be the audience of a campaign", async () => {
			const segment = await t.api(user.key, "POST", "/segments", { name: "Opened issue one", rules: { match: "all", conditions: [{ type: "issue", campaign: campaignId, action: "opened" }] } });
			const id = await t.draft(user, { segment: segment.body.id });
			const preview = (await t.api(user.key, "GET", `/campaigns/${id}/recipients`)).body;
			assert.equal(preview.recipients, 2, "ann and bob; eve unsubscribed");
			const before = sesEmails.length;
			assert.equal((await t.api(user.key, "POST", `/campaigns/${id}/send`)).status, 200);
			await t.runJobs(user);
			assert.deepEqual(sesEmails.slice(before).map(({ to }) => to.split("@")[0]).sort(), ["ann", "bob"]);
		});
	});
});

describe("saved lists", () => {
	let user;
	const email = (name) => `${name}@${user.slug}.example.org`;
	const vip = { match: "all", conditions: [{ type: "tag", value: "vip" }] };
	const snapshot = (body) => t.api(user.key, "POST", "/segments/snapshots", body);

	before(async () => {
		user = await t.customer("seg2-lists@example.com");
		await t.importReaders(user, 6, { tags: (index) => (index < 4 ? ["vip"] : []) });
	});

	test("keep the contacts a segment matched when it was saved, whatever happens to the list after", async () => {
		const created = await snapshot({ name: "Launch list", description: "Before the launch", rules: vip });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual(
			{ kind: created.body.kind, status: created.body.status, members: created.body.members, contacts: created.body.contacts, summary: created.body.summary },
			{ kind: "static", status: "ready", members: 4, contacts: 4, summary: "On the saved list Launch list" }
		);
		assert.ok(created.body.savedAt);
		const listId = created.body.id;

		await t.importReaders(user, 3, { prefix: "later", tags: () => ["vip"] });
		const reader0 = await t.m.Contact.findOne({ accountId: user.accountId, email: email("reader0") }).lean();
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: reader0._id }, { $set: { tags: [] } });
		const live = (await t.api(user.key, "POST", "/segments", { name: "Live VIPs", rules: vip })).body;
		assert.equal(live.contacts, 6, "the live segment follows the list");
		const got = (await t.api(user.key, "GET", `/segments/${listId}`)).body;
		assert.equal(got.preview.matching, 4, "the saved list does not");
		assert.deepEqual(got.preview.sample.map((contact) => contact.email.split("@")[0]).sort(), ["reader0", "reader1", "reader2", "reader3"]);
		assert.equal(await t.m.SegmentMember.countDocuments({ accountId: user.accountId, segmentId: listId }), 4);
		assert.equal((await t.api(user.key, "GET", "/segments")).body.segments.find(({ id }) => id === listId).kind, "static");
	});

	test("take a saved segment's name instead of rules, and only one of them", async () => {
		const source = (await t.api(user.key, "POST", "/segments", { name: "Tagged reader1", rules: vip })).body;
		const copy = await snapshot({ name: "Copy of tagged", segment: source.name });
		assert.equal(copy.status, 201, JSON.stringify(copy.body));
		assert.equal(copy.body.members, source.contacts);
		const again = await snapshot({ name: "Copy of the copy", segment: copy.body.id });
		assert.equal(again.body.members, copy.body.members, "a saved list can be copied");
		t.assertError(await snapshot({ name: "Both", segment: source.name, rules: vip }), 400, "validation_failed");
		t.assertError(await snapshot({ name: "Neither" }), 400, "validation_failed");
		t.assertError(await snapshot({ name: "Launch list", rules: vip }), 409, "conflict");
		t.assertError(await snapshot({ name: "Nothing", segment: "6650f1c2e9b1d4a012345678" }), 404, "not_found");
	});

	test("can be sent to, with the same checks as any segment", async () => {
		const list = (await snapshot({ name: "Send list", rules: vip })).body;
		await t.importReaders(user, 2, { prefix: "after", tags: () => ["vip"] });
		const reader1 = await t.m.Contact.findOne({ accountId: user.accountId, email: email("reader1") }).lean();
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: reader1._id }, { $set: { status: "unsubscribed" } });
		const id = await t.draft(user, { segment: list.id });
		const before = sesEmails.length;
		const sent = await t.api(user.key, "POST", `/campaigns/${id}/send`);
		assert.equal(sent.status, 200, JSON.stringify(sent.body));
		await t.runJobs(user);
		const reached = sesEmails.slice(before).map(({ to }) => to.split("@")[0]).sort();
		assert.deepEqual(reached.filter((name) => name.startsWith("after")), [], "later joiners are not on it");
		assert.ok(reached.includes("reader2") && !reached.includes("reader1"), "an unsubscribed member is skipped");
	});

	test("can't be changed, and are in use while another segment names them", async () => {
		const list = (await snapshot({ name: "Locked list", rules: vip })).body;
		t.assertError(await t.api(user.key, "PATCH", `/segments/${list.id}`, { rules: vip }), 409, "conflict");
		assert.equal((await t.api(user.key, "PATCH", `/segments/${list.id}`, { name: "Renamed list", description: "Still the same people" })).status, 200);

		const mixed = await t.api(user.key, "POST", "/segments", { name: "On the list and tagged", rules: { match: "all", conditions: [{ type: "snapshot", segment: list.id }, { type: "tag", value: "vip" }] } });
		assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
		assert.equal(mixed.body.summary, "On the saved list Renamed list and Has the tag vip");
		t.assertError(await t.api(user.key, "POST", "/segments", { name: "Bad", rules: { match: "all", conditions: [{ type: "snapshot", segment: mixed.body.id }] } }), 400, "validation_failed");
		const conflict = t.assertError(await t.api(user.key, "DELETE", `/segments/${list.id}`), 409, "conflict");
		assert.match(conflict, /On the list and tagged/);
		assert.equal((await t.api(user.key, "DELETE", `/segments/${mixed.body.id}`)).status, 200);
		assert.equal((await t.api(user.key, "DELETE", `/segments/${list.id}`)).status, 200);
		assert.equal(await t.m.SegmentMember.countDocuments({ accountId: user.accountId, segmentId: list.id }), 0, "its members go with it");
	});

	test("a large one fills in over jobs, and can't be sent to until it's ready", async () => {
		const user2 = await t.customer("seg2-large@example.com");
		await t.importReaders(user2, 30, { tags: () => ["vip"] });
		const limits = t.m.snapshots.SNAPSHOT_LIMITS;
		const saved = { ...limits };
		const stepMs = process.env.SNAPSHOT_STEP_MS;
		Object.assign(limits, { inline: 5, chunk: 10 });
		process.env.SNAPSHOT_STEP_MS = "0";
		try {
			const first = published.length;
			const created = await t.api(user2.key, "POST", "/segments/snapshots", { name: "Big list", rules: vip });
			assert.equal(created.status, 201, JSON.stringify(created.body));
			assert.deepEqual([created.body.status, created.body.members], ["building", null]);
			const id = created.body.id;

			const blocked = await t.api(user2.key, "POST", "/campaigns", { subject: "Issue", content: "Hello", segment: id });
			assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
			assert.match(blocked.body.error.message, /still being saved/);

			// Each step publishes the next, so the list of jobs grows as they run.
			let steps = 0;
			for (let index = first; index < published.length; index++) {
				const { url, body } = published[index];
				if (!url.endsWith("/api/jobs/snapshot-segment")) continue;
				steps++;
				const response = await t.m.snapshotRoute.POST(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
				assert.equal(response.status, 200);
			}
			assert.equal(steps, 4, "30 contacts, 10 to a page, one page to a step, and a step to see the end");
			const done = (await t.api(user2.key, "GET", `/segments/${id}`)).body;
			assert.deepEqual([done.status, done.members, done.preview.matching], ["ready", 30, 30]);
			assert.equal((await t.api(user2.key, "POST", "/campaigns", { subject: "Issue", content: "Hello", segment: id })).status, 201, "it can be sent to now");
			assert.equal(await t.m.SegmentMember.countDocuments({ accountId: user2.accountId, segmentId: id }), 30);
			assert.deepEqual(await t.m.snapshots.runSnapshotStep({ accountId: user2.accountId, segmentId: id }), { skipped: "ready" });
		} finally {
			Object.assign(limits, saved);
			if (stepMs === undefined) delete process.env.SNAPSHOT_STEP_MS;
			else process.env.SNAPSHOT_STEP_MS = stepMs;
		}
	});

	test("the job fails the list after three tries, and a list from another account is out of reach", async () => {
		const owner = await t.customer("seg2-owner@example.com");
		const other = await t.customer("seg2-other@example.com");
		await t.importReaders(owner, 3, { tags: () => ["vip"] });
		const list = (await t.api(owner.key, "POST", "/segments/snapshots", { name: "Mine", rules: vip })).body;
		t.assertError(await t.api(other.key, "GET", `/segments/${list.id}`), 404, "not_found");
		t.assertError(await t.api(other.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "snapshot", segment: list.id }] } }), 400, "validation_failed");

		const building = await t.m.Segment.create({
			accountId: owner.accountId,
			newsletterId: owner.newsletterId,
			name: "Broken",
			kind: "static",
			rules: { match: "all", conditions: [{ type: "snapshot", segment: ID(5), name: "Broken" }] },
			snapshotRules: { match: "all", conditions: [{ type: "issue", campaign: ID(6), action: "opened" }] },
			buildStatus: "building",
			snapshotAt: new Date(),
		});
		const Message = t.m.Message;
		const original = Message.distinct;
		Message.distinct = async () => {
			throw new Error("database busy");
		};
		try {
			for (let attempt = 1; attempt <= 2; attempt++) {
				await assert.rejects(t.m.snapshots.runSnapshotStep({ accountId: owner.accountId, segmentId: building._id }), /database busy/);
			}
			assert.deepEqual(await t.m.snapshots.runSnapshotStep({ accountId: owner.accountId, segmentId: building._id }), { failed: "database busy" });
		} finally {
			Message.distinct = original;
		}
		const failed = (await t.api(owner.key, "GET", `/segments/${building._id}`)).body;
		assert.equal(failed.status, "failed");
	});
});
