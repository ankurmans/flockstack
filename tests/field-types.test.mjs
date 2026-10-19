import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getOptionsProblem, parseFieldValue } from "../lib/custom-fields-rules.js";
import { castFilter } from "../lib/docdb/schema.js";
import { splitFilter } from "../lib/docdb/sql.js";
import { checkRules, compileRules, describeRules } from "../lib/segment-rules.js";
import { setupAudienceTests } from "./helpers/audience.mjs";

let t;

before(async () => {
	t = await setupAudienceTests();
});

after(() => t?.app.stop());

const TOPICS = { type: "list", options: ["News", "Deals", "Events"], multiple: true };
const PLAN = { type: "list", options: ["Free", "Pro"] };

describe("true/false, list and date-time fields", () => {
	test("parse their values", () => {
		assert.deepEqual(parseFieldValue("boolean", "Yes"), { value: true });
		assert.deepEqual(parseFieldValue("boolean", false), { value: false });
		assert.deepEqual(parseFieldValue("boolean", "0"), { value: false });
		assert.deepEqual(parseFieldValue("boolean", ""), { value: null });
		assert.ok(parseFieldValue("boolean", "maybe").problem);

		assert.deepEqual(parseFieldValue("datetime", "2026-03-14T09:30:00+02:00"), { value: "2026-03-14T07:30:00.000Z" });
		assert.deepEqual(parseFieldValue("datetime", "2026-03-14T09:30"), { value: "2026-03-14T09:30:00.000Z" }, "no zone reads as UTC");
		assert.deepEqual(parseFieldValue("datetime", "2026-03-14"), { value: "2026-03-14T00:00:00.000Z" });
		assert.ok(parseFieldValue("datetime", "soon").problem);

		assert.deepEqual(parseFieldValue("list", "pro", PLAN), { value: "Pro" }, "options match whatever the case");
		assert.ok(parseFieldValue("list", "Gold", PLAN).problem);
		assert.ok(parseFieldValue("list", "Free, Pro", PLAN).problem, "one option only");
		assert.deepEqual(parseFieldValue("list", "events, news", TOPICS), { value: ["News", "Events"] }, "in the options' order");
		assert.deepEqual(parseFieldValue("list", ["Deals", "deals"], TOPICS), { value: ["Deals"] });
		assert.deepEqual(parseFieldValue("list", [], TOPICS), { value: null });
		assert.ok(parseFieldValue("list", ["Nope"], TOPICS).problem);
	});

	test("need options that are plain and distinct", () => {
		assert.equal(getOptionsProblem(["A", "B"]), null);
		assert.match(getOptionsProblem([]), /at least one/);
		assert.match(getOptionsProblem(["A", "a"]), /twice/);
		assert.match(getOptionsProblem(["A, B"]), /comma/);
		assert.match(getOptionsProblem(Array.from({ length: 21 }, (_, index) => `O${index}`)), /20 at most/);
	});

	test("compile to segment filters the database answers on its own", async () => {
		const Contact = (await import("../models/Contact.js")).default;
		const fields = new Map([
			["topics", TOPICS],
			["plan", PLAN],
			["vip", { type: "boolean" }],
			["trial_ends", { type: "datetime" }],
		]);
		const { rules, problem } = checkRules(
			{
				match: "any",
				conditions: [
					{ type: "field", field: "topics", op: "includes", value: "news" },
					{ type: "field", field: "topics", op: "excludes", value: "Deals" },
					{ type: "field", field: "plan", op: "eq", value: "pro" },
					{ type: "field", field: "vip", op: "eq", value: true },
					{ type: "field", field: "trial_ends", op: "lt", value: "2026-11-01T00:00:00Z" },
				],
			},
			fields
		);
		assert.equal(problem, undefined);
		assert.deepEqual(rules.conditions[0], { type: "field", field: "topics", op: "includes", value: "News" });
		const filter = castFilter(Contact.schema, { accountId: "6650f1c2e9b1d4a012345678", ...compileRules(rules) });
		assert.equal(splitFilter(Contact.schema, filter).hasResidual, false);
		assert.match(describeRules(rules), /topics includes News or topics doesn't include Deals/);

		const check = (condition) => checkRules({ match: "all", conditions: [condition] }, fields).problem;
		assert.match(check({ type: "field", field: "vip", op: "gt", value: true }), /boolean field takes/);
		assert.match(check({ type: "field", field: "plan", op: "eq", value: "Gold" }), /one of/);
		assert.match(check({ type: "field", field: "topics", op: "contains", value: "x" }), /text fields/);
	});

	test("are created, set and segmented through the API", async () => {
		const user = await t.customer("field-types@example.com");
		const topics = await t.api(user.key, "POST", "/custom-fields", { label: "Topics", type: "list", options: ["News", "Deals", "Events"], multiple: true, readerEditable: true });
		assert.equal(topics.status, 201, JSON.stringify(topics.body));
		assert.deepEqual(
			{ type: topics.body.type, options: topics.body.options, multiple: topics.body.multiple, readerEditable: topics.body.readerEditable },
			{ type: "list", options: ["News", "Deals", "Events"], multiple: true, readerEditable: true }
		);
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "Empty", type: "list", options: [] }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "Odd", type: "text", options: ["A"] }), 400, "validation_failed");
		await t.api(user.key, "POST", "/custom-fields", { label: "VIP", type: "boolean" });
		await t.api(user.key, "POST", "/custom-fields", { label: "Trial ends", type: "datetime" });

		await t.importReaders(user, 3);
		const [ann, bob, cat] = (await t.api(user.key, "GET", "/contacts")).body.contacts;
		const set = (contact, field, value) => t.api(user.key, "PATCH", `/contacts/${contact.id}/fields`, { field, value });
		assert.deepEqual((await set(ann, "topics", ["events", "news"])).body.fields.topics, ["News", "Events"]);
		await set(bob, "topics", "Deals");
		await set(ann, "vip", true);
		await set(bob, "vip", "no");
		await set(cat, "trial_ends", "2026-10-30T12:00:00Z");
		t.assertError(await set(cat, "topics", ["Gossip"]), 400, "validation_failed");
		t.assertError(await set(cat, "vip", "perhaps"), 400, "validation_failed");
		assert.equal((await t.api(user.key, "GET", `/contacts/${ann.id}`)).body.fields.vip, true);

		const who = async (...conditions) =>
			(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions }, sample: 25 })).body.sample.map((contact) => contact.id).sort();
		assert.deepEqual(await who({ type: "field", field: "topics", op: "includes", value: "News" }), [ann.id]);
		assert.deepEqual(await who({ type: "field", field: "topics", op: "includes", value: "Deals" }), [bob.id]);
		assert.deepEqual(await who({ type: "field", field: "topics", op: "excludes", value: "News" }), [bob.id, cat.id].sort());
		assert.deepEqual(await who({ type: "field", field: "vip", op: "eq", value: false }), [bob.id]);
		assert.deepEqual(await who({ type: "field", field: "vip", op: "neq", value: true }), [bob.id, cat.id].sort());
		assert.deepEqual(await who({ type: "field", field: "trial_ends", op: "lt", value: "2026-11-01" }), [cat.id]);

		const renamed = await t.api(user.key, "PATCH", "/custom-fields/topics", { options: ["News", "Deals", "Events", "Jobs"], readerEditable: false });
		assert.deepEqual({ options: renamed.body.options, readerEditable: renamed.body.readerEditable }, { options: ["News", "Deals", "Events", "Jobs"], readerEditable: false });
		t.assertError(await t.api(user.key, "PATCH", "/custom-fields/vip", { options: ["A"] }), 400, "validation_failed");
	});
});
