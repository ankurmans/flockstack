import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(stripComments(read("wrangler.jsonc")));
const entry = read("worker-entry.mjs");
const jobs = Object.fromEntries([...entry.matchAll(/"([^"]+)":\s*"(\/api\/cron\/[a-z-]+)"/g)].map(([, cron, path]) => [cron, path]));

test("both Workers run the cron jobs worker-entry.mjs knows, and each job is a real route", () => {
	// Both Workers upload scripts/bundle-worker.mjs's bundle of worker-entry.mjs.
	for (const worker of [config, config.env.eu]) {
		assert.equal(worker.main, ".worker/worker-entry.js");
		assert.equal(worker.no_bundle, true);
		assert.equal(worker.build.command, "node scripts/bundle-worker.mjs");
	}
	assert.ok(existsSync(new URL("../worker-entry.mjs", import.meta.url)));
	for (const crons of [config.triggers.crons, config.env.eu.triggers.crons]) {
		assert.deepEqual([...crons].sort(), Object.keys(jobs).sort());
	}
	for (const path of Object.values(jobs)) assert.ok(existsSync(new URL(`../app${path}/route.js`, import.meta.url)), `${path} has no route`);
});
