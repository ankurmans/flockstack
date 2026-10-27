import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "../lib/docdb/index.js";
import { setDriver, sqliteDriver } from "../lib/docdb/driver.js";
import { accountScoped } from "../lib/account-scope.js";

// A query that asks for some fields has SQLite hand over those fields, not the document, and the documents come out as they
// always did: a field the document lacks stays missing, a null stays null, objects, arrays, booleans, numbers and dates are what
// they were, and what a query needs the whole document for (a filter SQL cannot run, a sort it cannot do) still reads it.
const articleSchema = new mongoose.Schema({
	title: { type: String },
	body: { type: String },
	status: { type: String },
	score: { type: Number },
	flag: { type: Boolean },
	note: { type: String },
	missing: { type: String },
	publishedAt: { type: Date },
	stats: { views: { type: Number }, shares: { type: Number } },
	tags: [{ type: String }],
});
articleSchema.plugin(accountScoped);
const Article = mongoose.model("ColumnsArticle", articleSchema);

const account = new mongoose.Types.ObjectId();
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
	await Article.init();
	await Article.insertMany([
		{ accountId: account, title: "One", body: "x".repeat(5000), status: "sent", score: 3, flag: true, note: null, publishedAt: new Date("2026-10-01T10:00:00Z"), stats: { views: 10, shares: 2 }, tags: ["a", "b"] },
		{ accountId: account, title: "Two", body: "y".repeat(5000), status: "draft", score: 0, flag: false, stats: { views: 0, shares: 0 }, tags: [] },
		{ accountId: account, title: "Three", body: "z".repeat(5000), status: "sent", score: 7, flag: true, note: "kept", publishedAt: new Date("2026-10-03T10:00:00Z"), tags: ["c"] },
	]);
});

after(() => inner?.close());

const read = async (run) => {
	statements = [];
	const result = await run();
	return { result, sql: statements.at(-1) };
};
const whole = (query) => query.select("-nothingToExclude");

describe("reading some fields", () => {
	test("select gives the same documents as reading them whole and picking the fields", async () => {
		const fields = { title: 1, status: 1, score: 1, flag: 1, note: 1, missing: 1, publishedAt: 1, stats: 1, tags: 1 };
		const filter = { accountId: account };
		const { result: picked, sql } = await read(() => Article.find(filter).select(fields).sort({ _id: 1 }).lean());
		assert.match(sql, /^SELECT _id AS _id, json_extract\(data, '\$\.title'\)/, "SQLite is asked for the fields");
		assert.doesNotMatch(sql, /\$\.body/, "and not for the body");
		const { result: full, sql: fullSql } = await read(() => whole(Article.find(filter)).sort({ _id: 1 }).lean());
		assert.match(fullSql, /^SELECT data FROM/);
		const expected = full.map((doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => key === "_id" || key in fields)));
		assert.deepEqual(picked, expected);
		assert.equal("note" in picked[1], false, "a field the document lacks stays missing");
		assert.equal(picked[0].note, null, "a null stays a null");
		assert.equal(picked[0].flag, true);
		assert.equal(picked[1].flag, false);
		assert.equal(picked[1].score, 0);
		assert.ok(picked[0].publishedAt instanceof Date);
		assert.deepEqual(picked[0].tags, ["a", "b"]);
		assert.deepEqual(picked[0].stats, { views: 10, shares: 2 });
	});

	test("a path inside an object reads that object and keeps the path", async () => {
		const { result, sql } = await read(() => Article.find({ accountId: account }).select({ "stats.views": 1 }).sort({ _id: 1 }).lean());
		assert.match(sql, /\$\.stats/);
		assert.deepEqual(result.map(({ stats }) => stats?.views), [10, 0, undefined]);
	});

	test("findOne, a sort and a limit run in SQL as before, and exists reads no field at all", async () => {
		const { result: top, sql } = await read(() => Article.find({ accountId: account }).select({ title: 1 }).sort({ score: -1 }).limit(2).lean());
		assert.deepEqual(top.map(({ title }) => title), ["Three", "One"]);
		assert.match(sql, /ORDER BY/);
		const { result: one } = await read(() => Article.findOne({ accountId: account, title: "Two" }).select({ title: 1, status: 1 }).lean());
		assert.deepEqual({ title: one.title, status: one.status }, { title: "Two", status: "draft" });
		const { result: found, sql: existsSql } = await read(() => Article.exists({ accountId: account, status: "sent" }));
		assert.ok(found._id);
		assert.doesNotMatch(existsSql, /SELECT data/);
	});

	test("distinct reads the field it collects", async () => {
		const { result, sql } = await read(() => Article.distinct("status", { accountId: account }));
		assert.deepEqual(result.toSorted(), ["draft", "sent"]);
		assert.doesNotMatch(sql, /SELECT data/);
	});

	test("an aggregate that starts by keeping fields has SQLite keep them, and the pipeline's answer is the same", async () => {
		const pipeline = (keep) => [
			{ $match: { accountId: account } },
			...(keep ? [{ $project: { title: 1, score: 1, status: 1 } }] : []),
			{ $addFields: { doubled: { $add: [{ $ifNull: ["$score", 0] }, { $ifNull: ["$score", 0] }] } } },
			{ $sort: { doubled: -1, _id: 1 } },
			{ $project: { title: 1, doubled: 1 } },
		];
		const { result: kept, sql } = await read(() => Article.aggregate(pipeline(true)));
		assert.doesNotMatch(sql, /\$\.body/);
		const { result: all } = await read(() => Article.aggregate(pipeline(false)));
		assert.deepEqual(kept, all);
		assert.deepEqual(kept.map(({ title, doubled }) => [title, doubled]), [["Three", 14], ["One", 6], ["Two", 0]]);
	});

	test("a filter SQL cannot run, or a field it cannot sort by, reads the whole document", async () => {
		const { result, sql } = await read(() => Article.find({ accountId: account, $expr: { $gt: ["$score", { $add: [1, 1] }] } }).select({ title: 1 }).sort({ _id: 1 }).lean());
		assert.match(sql, /^SELECT data FROM/);
		assert.deepEqual(result.map(({ title }) => title), ["One", "Three"]);
	});

	test("names that are not plain field names are read whole", async () => {
		const { result, sql } = await read(() => Article.find({ accountId: account }).select({ "tags.0": 1, title: 1 }).sort({ _id: 1 }).lean());
		assert.match(sql, /^SELECT _id AS _id/, "tags is a plain name, and is read whole");
		assert.ok(result.every(({ title }) => title));
	});
});
