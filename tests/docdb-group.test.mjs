import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "../lib/docdb/index.js";
import { setDriver, sqliteDriver } from "../lib/docdb/driver.js";
import { accountScoped } from "../lib/account-scope.js";

// Model.groupCount counts documents for each combination of some of their values in one GROUP BY, so a report over a big
// list reads the database's answer and not the list.
const joinSchema = new mongoose.Schema({
	source: { type: String },
	status: { type: String },
	joinedAt: { type: Date },
	updatedAtSomewhere: { type: Date },
	acquisition: { channel: { type: String }, utm: { campaign: { type: String } } },
});
joinSchema.plugin(accountScoped);
const Join = mongoose.model("GroupJoin", joinSchema);

const account = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
let inner;
let statements = [];

before(async () => {
	inner = await sqliteDriver(":memory:");
	setDriver({
		...inner,
		query: (sql, params) => {
			statements.push(sql);
			return inner.query(sql, params);
		},
		batch: (list) => inner.batch(list),
	});
	await Join.init();
	const day = (iso) => new Date(`${iso}T10:00:00.000Z`);
	await Join.insertMany(
		[
			["website", "active", "2026-10-01", "spring"],
			["website", "active", "2026-10-01", "spring"],
			["website", "unsubscribed", "2026-10-02", null],
			["popup", "active", "2026-10-02", "spring"],
			["popup", "pending", "2026-10-02", "autumn"],
			[null, "active", "2026-10-03", null],
		].map(([source, status, joined, campaign]) => ({
			accountId: account,
			source: source ?? undefined,
			status,
			joinedAt: day(joined),
			updatedAtSomewhere: day(joined),
			acquisition: { utm: campaign ? { campaign } : undefined, channel: "direct" },
		}))
	);
	await Join.insertMany([{ accountId: other, source: "website", status: "active", joinedAt: day("2026-10-01") }]);
});

after(() => inner.close());

const sorted = (rows, ...keys) => [...rows].sort((a, b) => keys.map((key) => String(a[key]).localeCompare(String(b[key]))).find(Boolean) ?? 0);

describe("groupCount", () => {
	test("counts by a value and by a day, in one statement", async () => {
		statements = [];
		const rows = await Join.groupCount({ accountId: account }, { day: { path: "joinedAt", slice: 10 }, source: "source" });
		assert.equal(statements.length, 1);
		assert.match(statements[0], /GROUP BY g0, g1/);
		assert.deepEqual(sorted(rows, "day", "source"), [
			{ day: "2026-10-01", source: "website", count: 2 },
			{ day: "2026-10-02", source: "popup", count: 2 },
			{ day: "2026-10-02", source: "website", count: 1 },
			{ day: "2026-10-03", source: null, count: 1 },
		]);
	});

	test("takes a filter, nested paths and a missing value as null, and counts one account's documents only", async () => {
		const rows = await Join.groupCount({ accountId: account, status: { $in: ["active", "pending"] } }, { campaign: "acquisition.utm.campaign" });
		assert.deepEqual(sorted(rows, "campaign"), [
			{ campaign: "autumn", count: 1 },
			{ campaign: "spring", count: 3 },
			{ campaign: null, count: 1 },
		].sort((a, b) => String(a.campaign).localeCompare(String(b.campaign))));
		const total = await Join.groupCount({ accountId: account }, {});
		assert.deepEqual(total, [{ count: 6 }]);
		assert.deepEqual(await Join.groupCount({ accountId: other }, { source: "source" }), [{ source: "website", count: 1 }]);
	});

	test("answers a range of dates from the index's side, and a filter SQL can't read by counting what it reads", async () => {
		const range = await Join.groupCount({ accountId: account, joinedAt: { $gte: new Date("2026-10-02T00:00:00Z"), $lt: new Date("2026-10-03T00:00:00Z") } }, { status: "status" });
		assert.deepEqual(sorted(range, "status"), [
			{ status: "active", count: 1 },
			{ status: "pending", count: 1 },
			{ status: "unsubscribed", count: 1 },
		]);
		statements = [];
		const residual = await Join.groupCount({ accountId: account, $expr: { $eq: ["$joinedAt", "$updatedAtSomewhere"] } }, { day: { path: "joinedAt", slice: 10 } });
		assert.ok(statements.every((sql) => !/GROUP BY/.test(sql)), "a filter the database can't answer is counted after reading");
		assert.deepEqual(sorted(residual, "day"), [
			{ day: "2026-10-01", count: 2 },
			{ day: "2026-10-02", count: 3 },
			{ day: "2026-10-03", count: 1 },
		]);
	});

	test("refuses a query without an account and a path that isn't one", async () => {
		await assert.rejects(Join.groupCount({}, { source: "source" }), /without an accountId/);
		await assert.rejects(Join.groupCount({ accountId: account }, { x: "source') FROM c_groupjoins --" }), /Can't group by/);
	});
});
