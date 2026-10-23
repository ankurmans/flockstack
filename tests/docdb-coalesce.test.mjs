import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { coalescingDriver, setQueryObserver, sqliteDriver } from "../lib/docdb/driver.js";

// coalescingDriver: the reads asked for in one turn of the event loop reach the database as one batch (one round trip on D1), each
// caller gets its own answer, a bad statement fails only its caller, and nothing but a plain SELECT is held back.
let db;
let events;
const plain = (rows) => JSON.parse(JSON.stringify(rows));

beforeEach(async () => {
	db = coalescingDriver(await sqliteDriver(":memory:"));
	await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
	await db.query("INSERT INTO t (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three')");
	events = [];
	setQueryObserver((event) => events.push(event));
});

describe("reads of one turn", () => {
	test("go together as one batch, and each caller gets the rows of its own statement, in any order they finish", async () => {
		const [a, b, c] = await Promise.all([db.query("SELECT name FROM t WHERE id = ?", [3]), db.query("SELECT name FROM t WHERE id = ?", [1]), db.query("SELECT COUNT(*) AS n FROM t")]);
		assert.deepEqual(plain([a.rows, b.rows, c.rows]), [[{ name: "three" }], [{ name: "one" }], [{ n: 3 }]]);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "batch");
		assert.equal(events[0].statements, 3);
	});

	test("a read alone in its turn is a plain query, and a read in a later turn is its own", async () => {
		await db.query("SELECT 1 AS one");
		await db.query("SELECT 2 AS two");
		assert.deepEqual(events.map(({ kind }) => kind), ["query", "query"]);
	});

	test("a statement that fails fails its own caller only, and the others still get their rows", async () => {
		const results = await Promise.allSettled([db.query("SELECT name FROM t WHERE id = 2"), db.query("SELECT * FROM missing_table"), db.query("SELECT name FROM t WHERE id = 1")]);
		assert.equal(results[0].status, "fulfilled");
		assert.deepEqual(plain(results[0].value.rows), [{ name: "two" }]);
		assert.equal(results[1].status, "rejected");
		assert.match(String(results[1].reason), /missing_table/);
		assert.deepEqual(plain(results[2].value.rows), [{ name: "one" }]);
	});

	test("more than the batch limit are split into batches of that size", async () => {
		const answers = await Promise.all(Array.from({ length: 95 }, (_, index) => db.query("SELECT ? AS n", [index])));
		assert.deepEqual(answers.map(({ rows }) => rows[0].n), Array.from({ length: 95 }, (_, index) => index));
		assert.deepEqual(events.map(({ statements }) => statements), [40, 40, 15]);
	});
});

describe("what is not held back", () => {
	test("writes go at once, in the order they were asked, and a read after a write in the same turn sees it once awaited", async () => {
		const write = db.query("INSERT INTO t (id, name) VALUES (4, 'four')");
		const read = db.query("SELECT COUNT(*) AS n FROM t");
		await write;
		assert.deepEqual(plain((await read).rows), [{ n: 4 }]);
		assert.equal(events[0].kind, "query", "the write was not batched with a read");
	});

	test("a SELECT with RETURNING-like writes, and batches the caller made, pass straight through", async () => {
		await db.batch([{ sql: "INSERT INTO t (id, name) VALUES (5, 'five')", params: [] }, { sql: "SELECT COUNT(*) AS n FROM t", params: [] }]);
		assert.equal(events.length, 1);
		const updated = await db.query("UPDATE t SET name = 'FIVE' WHERE id = 5 RETURNING name");
		assert.deepEqual(plain(updated.rows), [{ name: "FIVE" }]);
	});
});
