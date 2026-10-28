import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildBriefingsWorker } from "../scripts/build-briefings-worker.mjs";
import { readBudgets } from "../scripts/perf-budget.mjs";
import { HEALTH_PATH, TICK_BUDGET_MS, apiDelivery, createBriefingsWorker } from "../workers/briefings/worker.js";

// The optional briefings Worker (workers/briefings, docs/BRIEFINGS-DESIGN.md): one ES module with the engine and the shared database
// code, and nothing of Next.js, React, SES or sign-in; a Cron Trigger runs a tick of the engine, whose deliveries go to the API Worker's
// BriefingsDelivery entrypoint through the API binding. The engine itself is tested in its own files; here it is a stand-in.
let folder;
let outFile;
let source;
let built;
const ctx = { waitUntil() {} };

before(async () => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-briefings-build-"));
	outFile = join(folder, "index.js");
	const result = await buildBriefingsWorker({ outFile, metafile: true });
	assert.equal(result.outFile, outFile);
	source = readFileSync(outFile, "utf8");
	built = (await import(pathToFileURL(outFile).href)).default;
});

after(() => rmSync(folder, { recursive: true, force: true }));

describe("the built briefings Worker", () => {
	test("has the engine and no Next.js, React, server components, SES or sign-in code", () => {
		const meta = JSON.parse(readFileSync(`${outFile}.meta.json`, "utf8"));
		const inputs = Object.keys(Object.values(meta.outputs)[0].inputs);
		for (const input of inputs) {
			assert.doesNotMatch(input, /node_modules\/(next|react|react-dom|scheduler|@opennextjs|better-auth|@better-auth|stripe|@tiptap|prosemirror|@aws-sdk)\//, input);
			assert.doesNotMatch(input, /^(app\/|components\/)/, input);
			assert.doesNotMatch(input, /^lib\/(ses|sending|auth|alerts|platform-email|briefings-delivery)\.js$/, `${input}: delivery is the API Worker's`);
		}
		assert.ok(inputs.includes("lib/briefings/index.js"), "the engine is in it");
		assert.ok(inputs.includes("workers/briefings/index.js"));
		assert.doesNotMatch(source, /from"next\/|from "next\/|require\("next|react-dom/);
	});

	test("has no character above U+00FF and is inside its budget", () => {
		assert.equal(source.search(/[^\x00-\xff]/), -1);
		const { maxBytes } = readBudgets()["briefings-worker"];
		assert.ok(statSync(outFile).size <= maxBytes, `${statSync(outFile).size} bytes, over ${maxBytes}`);
	});

	test("answers only its health path over HTTP, and says when it lacks a binding or is switched off", async () => {
		for (const path of ["/", "/api/v1/briefings", "/__briefings/run", `${HEALTH_PATH}/x`]) {
			const response = await built.fetch(new Request(`https://briefings.example.com${path}`, { method: "POST" }), { DB: {}, API: {} }, ctx);
			assert.equal(response.status, 404, path);
		}
		const health = (env) => built.fetch(new Request(`https://briefings.example.com${HEALTH_PATH}`), env, ctx);
		assert.equal((await health({ DB: {}, API: {} })).status, 200);
		assert.equal((await health({ DB: {} })).status, 503);
		assert.equal(await (await health({ DB: {}, API: {}, BRIEFINGS_DISABLED: "true" })).text(), "off\n");
	});

	test("a tick does nothing when switched off or missing a binding, before it loads the engine or touches a database", async () => {
		assert.deepEqual(await built.scheduled({ cron: "*/10 * * * *" }, { DB: {}, API: {}, BRIEFINGS_DISABLED: "TRUE" }, ctx), { skipped: "switched off" });
		const errors = console.error;
		console.error = () => {};
		try {
			assert.deepEqual(await built.scheduled({ cron: "*/10 * * * *" }, { API: {} }, ctx), { skipped: "not configured" });
			assert.deepEqual(await built.scheduled({ cron: "*/10 * * * *" }, { DB: {} }, ctx), { skipped: "not configured" });
		} finally {
			console.error = errors;
		}
	});
});

describe("a tick", () => {
	test("runs the engine with the region's bindings, its time budget, and the API Worker's RPC methods as the delivery", async () => {
		const calls = [];
		const ticks = [];
		const api = {
			async deliverIssue(payload) {
				calls.push(["deliverIssue", payload]);
				return { campaignId: "6650f1c2e9b1d4a012345678" };
			},
			async notifyOwner(message) {
				calls.push(["notifyOwner", message]);
				return { notified: true };
			},
		};
		const ai = { run: async () => ({}) };
		const env = { DB: { prepare() {} }, API: api, AI: ai };
		const worker = createBriefingsWorker({
			loadEngine: async () => ({
				async runTick(options) {
					ticks.push(options);
					const delivered = await options.delivery.deliverIssue({ briefingId: "b", slot: "2026-10-28" });
					await options.delivery.notifyOwner({ accountId: "a", briefingId: "b", subject: "No news", text: "Nothing new" });
					return { claimed: 1, advanced: 1, finished: 1, delivered };
				},
			}),
		});
		const info = console.info;
		console.info = () => {};
		let result;
		try {
			result = await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
		} finally {
			console.info = info;
		}
		assert.deepEqual(result, { claimed: 1, advanced: 1, finished: 1, delivered: { campaignId: "6650f1c2e9b1d4a012345678" } });
		assert.equal(ticks.length, 1);
		const [options] = ticks;
		assert.equal(options.env, env);
		assert.equal(options.ai, ai);
		assert.equal(options.timeBudgetMs, TICK_BUDGET_MS);
		assert.ok(TICK_BUDGET_MS <= 10 * 60_000, "a tick ends before the next one starts");
		assert.ok(options.now instanceof Date && Math.abs(options.now - Date.now()) < 5000);
		assert.equal(typeof options.fetchImpl, "function");
		assert.deepEqual(calls.map(([name]) => name), ["deliverIssue", "notifyOwner"]);
		assert.deepEqual(calls[0][1], { briefingId: "b", slot: "2026-10-28" });
	});

	test("the delivery calls each RPC method on the binding itself, so a service binding stub keeps its this", async () => {
		const seen = [];
		const stub = {
			deliverIssue(payload) {
				seen.push([this, payload]);
				return { campaignId: "c" };
			},
			notifyOwner(message) {
				seen.push([this, message]);
			},
		};
		const delivery = apiDelivery(stub);
		assert.deepEqual(await delivery.deliverIssue({ id: 1 }), { campaignId: "c" });
		await delivery.notifyOwner({ id: 2 });
		assert.ok(seen.every(([self]) => self === stub));
	});

	test("an engine error reaches the Cron Trigger, so the failed tick shows in its past events", async () => {
		const worker = createBriefingsWorker({ loadEngine: async () => ({ runTick: async () => { throw new Error("database is locked"); } }) });
		await assert.rejects(worker.scheduled({}, { DB: {}, API: {} }, ctx), /database is locked/);
	});
});

describe("the API Worker's BriefingsDelivery entrypoint", () => {
	test("exposes deliverIssue and notifyOwner and loads the delivery module only when called", () => {
		const text = readFileSync(new URL("../workers/api/index.js", import.meta.url), "utf8");
		assert.match(text, /export class BriefingsDelivery extends WorkerEntrypoint/);
		assert.match(text, /async deliverIssue\(payload\)/);
		assert.match(text, /async notifyOwner\(message\)/);
		assert.doesNotMatch(text, /^import[^\n]*briefings-delivery/m, "no static import: an API request never evaluates it");
		assert.match(text, /await import\("\.\.\/\.\.\/lib\/briefings-delivery\.js"\)/);
	});
});
