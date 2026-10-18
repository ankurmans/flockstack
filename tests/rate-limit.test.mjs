import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setDriver, sqliteDriver } from "../lib/docdb/driver.js";
import { isLimitedInDatabase, isLimitedInMemory, isRateLimited } from "../lib/rate-limit.js";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const LOGIN = { name: "test-login", limit: 3, window: "15 m" };
let database;

before(async () => {
	database = await sqliteDriver(":memory:");
	setDriver(database);
});

after(() => database?.close());

async function countAllowed(options, attempts, limiter) {
	let allowed = 0;
	for (let attempt = 0; attempt < attempts; attempt += 1) if (!(await isRateLimited(options, limiter))) allowed += 1;
	return allowed;
}

test("without Redis, limits still apply, counted in the database per key", async () => {
	const results = [];
	for (let attempt = 0; attempt < 4; attempt += 1) results.push(await isRateLimited({ ...LOGIN, key: "203.0.113.7" }));
	assert.deepEqual(results, [false, false, false, true]);
	assert.equal(await isRateLimited({ ...LOGIN, key: "203.0.113.8" }), false, "other visitors keep their own count");
	assert.equal(await isRateLimited({ ...LOGIN, name: "test-other", key: "203.0.113.7" }), false, "and other limits");
});

test("a Redis error or timeout falls back to memory instead of letting everything through", async (t) => {
	t.mock.method(console, "error", () => {});
	const failing = { limit: async () => Promise.reject(new Error("fetch failed")) };
	const timingOut = { limit: async () => ({ success: true, reason: "timeout" }) };
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.3" }, 5, failing), 3);
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.4" }, 5, timingOut), 3);

	const reports = console.error.mock.calls.filter(({ arguments: [message] }) => /unavailable, counting in memory/.test(message));
	assert.equal(reports.length, 1, "an outage is reported at most every 30 minutes, not on every request");
});

test("Redis answers decide while it's up", async () => {
	const allowing = { limit: async () => ({ success: true }) };
	const refusing = { limit: async () => ({ success: false }) };
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.5" }, 5, allowing), 5);
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.5" }, 2, refusing), 0);
});

test("memory limits open again once the window has passed", () => {
	const limits = { name: "test-window", limit: 2, window: "10 m" };
	const start = Date.parse("2026-10-09T12:00:00Z");
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 1000), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 2000), true);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 10 * 60_000 + 1000), false);
});

test("database limits are a sliding window: the last window's hits fade as the new one goes on", async () => {
	const limits = { name: "test-sliding", limit: 4, window: "10 m" };
	const start = Date.parse("2026-10-09T12:00:00Z");
	const hit = (offset) => isLimitedInDatabase({ ...limits, key: "visitor" }, start + offset);
	assert.deepEqual([await hit(0), await hit(1000), await hit(2000), await hit(3000), await hit(4000)], [false, false, false, false, true]);
	// Next window, halfway in: the four old hits count about half, so three more fit before the limit.
	const next = 10 * 60_000 + 5 * 60_000;
	assert.deepEqual([await hit(next), await hit(next + 1000), await hit(next + 2000), await hit(next + 3000)], [false, false, false, true]);
	// Two windows later, nothing is left of them.
	assert.equal(await hit(30 * 60_000), false);
	assert.equal(await isLimitedInDatabase({ ...limits, key: "someone-else" }, start), false, "another visitor starts empty");
});

test("a limit that asks for memory never touches the database", async () => {
	const limits = { name: "test-memory-only", limit: 1, window: "10 m", store: "memory", key: "a" };
	assert.equal(await isRateLimited(limits), false);
	assert.equal(await isRateLimited(limits), true);
});

test("when the database errors, limits fall back to memory and say so once", async (t) => {
	t.mock.method(console, "error", () => {});
	setDriver({ ...database, query: async () => Promise.reject(new Error("D1 is down")), batch: async () => Promise.reject(new Error("D1 is down")), managedSchema: true });
	try {
		assert.equal(await countAllowed({ name: "test-db-down", limit: 3, window: "15 m", key: "198.51.100.30" }, 5), 3);
	} finally {
		setDriver(database);
	}
});
