import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import mongoose from "../lib/docdb/index.js";
import { setDriver, sqliteDriver } from "../lib/docdb/driver.js";
import { BULK_LIMITS } from "../lib/docdb/model.js";
import { castFilter } from "../lib/docdb/schema.js";
import { schemaStatements, splitFilter } from "../lib/docdb/sql.js";
import { accountScoped } from "../lib/account-scope.js";
import Contact from "../models/Contact.js";

// Bulk writes go in a few statements (lib/docdb/model.js) and must give what the same operations one by one would.
// The limits are lowered so a handful of documents crosses every chunk and page boundary.
const SMALL = { rowsPerStatement: 3, paramBytes: 400, scanPage: 4, bulkChunk: 5, deleteChunk: 4 };
const DEFAULTS = { ...BULK_LIMITS };

const thingSchema = new mongoose.Schema(
	{
		key: { type: String, required: true },
		code: { type: String },
		kind: { type: String, enum: ["a", "b"], default: "a" },
		count: { type: Number, default: 0 },
		tags: { type: [String], default: undefined },
		note: { type: String },
	},
	{ timestamps: true }
);
thingSchema.plugin(accountScoped);
thingSchema.index({ key: 1 }, { unique: true });
thingSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: "string" } } });
const Thing = mongoose.model("BulkThing", thingSchema);

const accountA = new mongoose.Types.ObjectId();
const accountB = new mongoose.Types.ObjectId();
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
		batch: (list) => {
			statements.push(...list.map(({ sql }) => sql));
			return list.length > 0 && interceptBatch ? interceptBatch(list) : inner.batch(list);
		},
	});
	await Thing.init();
	await Contact.init();
});

after(() => {
	Object.assign(BULK_LIMITS, DEFAULTS);
	inner.close();
});

let interceptBatch = null;

beforeEach(async () => {
	Object.assign(BULK_LIMITS, SMALL);
	interceptBatch = null;
	await Thing.deleteMany({}).setOptions({ crossAccount: true });
	await Contact.deleteMany({}).setOptions({ crossAccount: true });
	statements = [];
});

function upsert(accountId, key, update) {
	return { updateOne: { filter: { accountId, key }, update, upsert: true } };
}

async function keys(filter) {
	return (await Thing.find(filter).setOptions({ crossAccount: true }).sort({ key: 1 }).lean()).map(({ key }) => key);
}

describe("bulkWrite", () => {
	test("upserts across chunks and statements, with the counts one by one would give", async () => {
		await Thing.create([{ accountId: accountA, key: "k02", count: 1 }, { accountId: accountA, key: "k07", count: 1 }]);
		const operations = Array.from({ length: 12 }, (_, index) => upsert(accountA, `k${String(index).padStart(2, "0")}`, { $inc: { count: 1 }, $setOnInsert: { note: "new" } }));
		const result = await Thing.bulkWrite(operations, { ordered: false });
		assert.deepEqual(result, { insertedCount: 0, matchedCount: 2, modifiedCount: 2, deletedCount: 0, upsertedCount: 10 });
		const stored = await Thing.find({ accountId: accountA }).sort({ key: 1 }).lean();
		assert.equal(stored.length, 12);
		assert.deepEqual(stored.map(({ count }) => count), [1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1]);
		assert.equal(stored[2].note, undefined, "$setOnInsert leaves existing documents alone");
		assert.equal(stored[0].note, "new");
		assert.ok(stored.every(({ createdAt, updatedAt }) => createdAt instanceof Date && updatedAt >= createdAt));
	});

	test("the same key twice in a chunk: the second operation finds what the first inserted", async () => {
		const result = await Thing.bulkWrite([
			upsert(accountA, "dup", { $addToSet: { tags: ["one"] }, $inc: { count: 1 } }),
			upsert(accountA, "other", { $inc: { count: 1 } }),
			upsert(accountA, "dup", { $addToSet: { tags: ["two", "one"] }, $inc: { count: 1 } }),
		]);
		assert.equal(result.upsertedCount, 2);
		assert.equal(result.matchedCount, 1);
		const dup = await Thing.findOne({ accountId: accountA, key: "dup" }).lean();
		assert.deepEqual(dup.tags, ["one", "two"]);
		assert.equal(dup.count, 2);
	});

	test("reads a chunk at once and writes it in a few statements", async () => {
		Object.assign(BULK_LIMITS, DEFAULTS);
		const operations = Array.from({ length: 300 }, (_, index) => upsert(accountA, `key-${index}`, { $set: { note: "x" } }));
		await Thing.bulkWrite(operations);
		assert.ok(statements.length <= 3, `${statements.length} statements`);
		statements = [];
		await Thing.bulkWrite(operations.map(({ updateOne }) => ({ updateOne: { ...updateOne, update: { $set: { note: "y" } } } })));
		assert.ok(statements.length <= 3, `${statements.length} statements`);
		assert.equal(await Thing.countDocuments({ accountId: accountA, note: "y" }), 300);
	});

	test("stays inside its account", async () => {
		await Thing.create({ accountId: accountB, key: "b-only", count: 5 });
		await Thing.bulkWrite([upsert(accountA, "a-1", { $inc: { count: 1 } }), upsert(accountA, "a-2", { $inc: { count: 1 } })]);
		assert.deepEqual(await keys({ accountId: accountA }), ["a-1", "a-2"]);
		assert.equal((await Thing.findOne({ accountId: accountB, key: "b-only" }).lean()).count, 5);
		await assert.rejects(Thing.bulkWrite([{ updateOne: { filter: { key: "b-only" }, update: { $set: { note: "no" } } } }]), /without an accountId/);
	});

	test("a key another account holds is a duplicate, as one by one", async () => {
		await Thing.create({ accountId: accountB, key: "taken" });
		await assert.rejects(
			Thing.bulkWrite([upsert(accountA, "free", { $set: { note: "x" } }), upsert(accountA, "taken", { $set: { note: "x" } })]),
			(error) => error.code === 11000
		);
		assert.deepEqual(await keys({ accountId: accountA }), ["free"], "what came before the duplicate stays, as it would one by one");
		assert.equal((await Thing.findOne({ accountId: accountB, key: "taken" }).lean()).note, undefined);
	});

	test("an invalid document stops where it would one by one", async () => {
		await assert.rejects(
			Thing.bulkWrite([upsert(accountA, "ok-1", { $set: { note: "x" } }), upsert(accountA, "bad", { $set: { kind: "zzz" } }), upsert(accountA, "ok-2", { $set: { note: "x" } })]),
			/not a valid enum value/
		);
		assert.deepEqual(await keys({ accountId: accountA }), ["ok-1"]);
	});

	test("a row that changes between the read and the write gets its operation again", async () => {
		await Thing.create([{ accountId: accountA, key: "race", count: 1 }, { accountId: accountA, key: "calm", count: 1 }]);
		interceptBatch = async (list) => {
			interceptBatch = null;
			await inner.query("UPDATE c_bulkthings SET data = json_set(data, '$.count', 10) WHERE json_extract(data, '$.key') = 'race'");
			return inner.batch(list);
		};
		const result = await Thing.bulkWrite([upsert(accountA, "race", { $inc: { count: 1 } }), upsert(accountA, "calm", { $inc: { count: 1 } })]);
		assert.equal(result.modifiedCount, 2);
		assert.equal((await Thing.findOne({ accountId: accountA, key: "race" }).lean()).count, 11);
		assert.equal((await Thing.findOne({ accountId: accountA, key: "calm" }).lean()).count, 2);
	});

	test("text that needs escaping comes back as it went in", async () => {
		const notes = ['quote " and \\ backslash', "line\nbreak\ttab", "emoji 😀 and   separator", "control \u0001 char", "é ü ß 中文"];
		await Thing.bulkWrite(notes.map((note, index) => upsert(accountA, `text-${index}`, { $set: { note } })));
		const stored = await Thing.find({ accountId: accountA }).sort({ key: 1 }).lean();
		assert.deepEqual(stored.map(({ note }) => note), notes);
		await Thing.updateMany({ accountId: accountA }, { $set: { kind: "b" } });
		assert.deepEqual((await Thing.find({ accountId: accountA }).sort({ key: 1 }).lean()).map(({ note }) => note), notes);
	});
});

describe("insertMany", () => {
	test("goes in chunks, and unordered skips duplicates and says how many", async () => {
		await Thing.create({ accountId: accountA, key: "k3" });
		await assert.rejects(
			Thing.insertMany(Array.from({ length: 8 }, (_, index) => ({ accountId: accountA, key: `k${index}` })), { ordered: false }),
			(error) => error.code === 11000 && error.writeErrors.length === 1
		);
		assert.equal(await Thing.countDocuments({ accountId: accountA }), 8);
	});

	test("ordered, a duplicate leaves nothing in", async () => {
		await Thing.create({ accountId: accountA, key: "k5" });
		await assert.rejects(
			Thing.insertMany(Array.from({ length: 8 }, (_, index) => ({ accountId: accountA, key: `k${index}` }))),
			(error) => error.code === 11000
		);
		assert.deepEqual(await keys({ accountId: accountA }), ["k5"]);
	});

	test("a document bigger than a chunk goes alone", async () => {
		const big = "x".repeat(2000);
		await Thing.insertMany([{ accountId: accountA, key: "small", note: "s" }, { accountId: accountA, key: "big", note: big }, { accountId: accountA, key: "small-2" }]);
		assert.equal((await Thing.findOne({ accountId: accountA, key: "big" }).lean()).note, big);
		await Thing.updateMany({ accountId: accountA }, { $inc: { count: 1 } });
		assert.deepEqual((await Thing.find({ accountId: accountA }).lean()).map(({ count }) => count), [1, 1, 1]);
	});
});

describe("updateMany", () => {
	test("pages through every match, its account only, and counts what changed", async () => {
		await Thing.insertMany(Array.from({ length: 11 }, (_, index) => ({ accountId: accountA, key: `a${index}`, count: index })));
		await Thing.insertMany(Array.from({ length: 3 }, (_, index) => ({ accountId: accountB, key: `b${index}` })));
		const result = await Thing.updateMany({ accountId: accountA, count: { $gte: 1 } }, { $set: { kind: "b" } });
		assert.equal(result.matchedCount, 10);
		assert.equal(result.modifiedCount, 10);
		assert.equal(await Thing.countDocuments({ accountId: accountA, kind: "b" }), 10);
		assert.equal(await Thing.countDocuments({ accountId: accountB, kind: "b" }), 0);
		await assert.rejects(Thing.updateMany({ kind: "a" }, { $set: { note: "x" } }), /without an accountId/);
	});

	test("a filter only JavaScript can check still pages", async () => {
		await Thing.insertMany(Array.from({ length: 9 }, (_, index) => ({ accountId: accountA, key: `r${index}`, note: index % 2 ? "odd" : "even" })));
		const result = await Thing.updateMany({ accountId: accountA, note: { $regex: "E", $options: "i" } }, { $inc: { count: 5 } });
		assert.equal(result.matchedCount, 5);
		assert.equal(await Thing.countDocuments({ accountId: accountA, count: 5 }), 5);
	});

	test("a row that changes between the read and the write is redone against its new content", async () => {
		await Thing.insertMany(Array.from({ length: 6 }, (_, index) => ({ accountId: accountA, key: `c${index}`, count: 1 })));
		interceptBatch = async (list) => {
			interceptBatch = null;
			await inner.query("UPDATE c_bulkthings SET data = json_set(data, '$.count', 100) WHERE json_extract(data, '$.key') = 'c0'");
			return inner.batch(list);
		};
		const result = await Thing.updateMany({ accountId: accountA }, { $inc: { count: 1 } });
		assert.equal(result.modifiedCount, 6);
		const counts = Object.fromEntries((await Thing.find({ accountId: accountA }).lean()).map(({ key, count }) => [key, count]));
		assert.deepEqual(counts, { c0: 101, c1: 2, c2: 2, c3: 2, c4: 2, c5: 2 });
	});

	test("a row that stops matching before its page is read is left alone", async () => {
		Object.assign(BULK_LIMITS, { scanPage: 2 });
		await Thing.insertMany(Array.from({ length: 6 }, (_, index) => ({ accountId: accountA, key: `s${index}` })));
		let reads = 0;
		const original = inner.query;
		const query = async (sql, params) => {
			if (sql.includes("CROSS JOIN") && ++reads === 2) {
				await original("UPDATE c_bulkthings SET data = json_set(data, '$.kind', 'b') WHERE json_extract(data, '$.key') = 's5'");
			}
			return original(sql, params);
		};
		inner.query = query;
		try {
			const result = await Thing.updateMany({ accountId: accountA, kind: "a" }, { $set: { note: "seen" } });
			assert.equal(result.modifiedCount, 5);
		} finally {
			inner.query = original;
		}
		assert.equal((await Thing.findOne({ accountId: accountA, key: "s5" }).lean()).note, undefined);
	});
});

describe("deleteMany", () => {
	test("deletes in chunks, its account only", async () => {
		await Thing.insertMany(Array.from({ length: 10 }, (_, index) => ({ accountId: accountA, key: `d${index}` })));
		await Thing.insertMany(Array.from({ length: 3 }, (_, index) => ({ accountId: accountB, key: `e${index}` })));
		assert.equal((await Thing.deleteMany({ accountId: accountA })).deletedCount, 10);
		assert.equal(await Thing.countDocuments({ accountId: accountB }), 3);
		assert.equal(statements.filter((sql) => sql.startsWith("DELETE")).length, 3, "4 a statement");
	});

	test("with a filter only JavaScript can check", async () => {
		await Thing.insertMany(Array.from({ length: 9 }, (_, index) => ({ accountId: accountA, key: `f${index}`, note: index < 7 ? "Gone" : "kept" })));
		assert.equal((await Thing.deleteMany({ accountId: accountA, note: { $regex: "gone", $options: "i" } })).deletedCount, 7);
		assert.deepEqual(await keys({ accountId: accountA }), ["f7", "f8"]);
	});

	test("with a limit, deletes that many at most, in SQL or not", async () => {
		await Thing.insertMany(Array.from({ length: 10 }, (_, index) => ({ accountId: accountA, key: `g${index}`, note: "Gone" })));
		assert.equal((await Thing.deleteMany({ accountId: accountA }).setOptions({ limit: 6 })).deletedCount, 6);
		assert.equal(statements.filter((sql) => sql.startsWith("DELETE")).length, 2, "4, then the 2 left of the limit");
		assert.equal((await Thing.deleteMany({ accountId: accountA, note: { $regex: "gone", $options: "i" } }).setOptions({ limit: 3 })).deletedCount, 3);
		assert.equal(await Thing.countDocuments({ accountId: accountA }), 1);
		assert.equal((await Thing.deleteMany({ accountId: accountA }).setOptions({ limit: 5 })).deletedCount, 1);
	});
});

describe("query plans", () => {
	// SQLite without statistics would take these through an index of the status, past every contact with it.
	function plan(filter) {
		const db = new DatabaseSync(":memory:");
		for (const sql of schemaStatements("contacts", Contact.schema)) db.exec(sql);
		const { where, params } = splitFilter(Contact.schema, castFilter(Contact.schema, filter));
		const detail = db.prepare(`EXPLAIN QUERY PLAN SELECT data FROM c_contacts WHERE ${where}`).all(...params).map((row) => row.detail).join(" | ");
		db.close();
		return detail;
	}

	test("addresses beat the status, and ids beat everything", () => {
		const accountId = String(accountA);
		assert.match(plan({ accountId, email: { $in: ["a@example.com"] }, status: { $in: ["active", "dormant"] } }), /INDEX i_contacts__accountId__email /);
		assert.match(plan({ accountId, newsletterId: accountId, email: { $in: ["a@example.com"] }, status: { $in: ["active"] } }), /INDEX u_contacts__newsletterId__email /);
		assert.match(plan({ accountId, _id: { $in: [accountId] }, status: "active" }), /sqlite_autoindex_c_contacts_1 \(_id=\?\)/);
		assert.match(plan({ accountId, newsletterId: accountId, status: "active" }), /INDEX i_contacts__newsletterId__status/);
	});
});
