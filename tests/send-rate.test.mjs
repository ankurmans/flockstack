import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LIMITS } from "../lib/config.js";
import { waitForSendSlot } from "../lib/send-rate.js";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

test("the SES rate comes from SEND_RATE_PER_SECOND, 14 by default", () => {
	process.env.SEND_RATE_PER_SECOND = "";
	assert.equal(LIMITS.sendRatePerSecond, 14);
	process.env.SEND_RATE_PER_SECOND = "40";
	assert.equal(LIMITS.sendRatePerSecond, 40);
	process.env.SEND_RATE_PER_SECOND = "0";
	assert.equal(LIMITS.sendRatePerSecond, 14);
});

test("concurrent sends in one instance are spaced at the rate", async () => {
	process.env.SEND_RATE_PER_SECOND = "20";
	await new Promise((resolve) => setTimeout(resolve, 100));
	const start = Date.now();
	await Promise.all(Array.from({ length: 5 }, () => waitForSendSlot()));
	assert.ok(Date.now() - start >= 190, "4 gaps of 50 ms");
});

test("sends go on, spaced per instance, while Upstash is down", async () => {
	process.env.SEND_RATE_PER_SECOND = "1000";
	process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
	process.env.UPSTASH_REDIS_REST_TOKEN = "token";
	let calls = 0;
	let callsAfterFirst;
	globalThis.fetch = async () => {
		calls++;
		throw new Error("connect ECONNREFUSED");
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		await waitForSendSlot();
		callsAfterFirst = calls;
		await waitForSendSlot();
	} finally {
		console.error = originalError;
	}
	assert.ok(callsAfterFirst > 0, "asked Upstash first");
	assert.equal(calls, callsAfterFirst, "then stopped asking for a minute");
});
