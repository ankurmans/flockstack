import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The suites that go through the reader endpoints (the open pixel, the click redirect, unsubscribe, the beacons, the signup form's
// address), run again with FLOCKSTACK_READERS_TARGET=worker: each request goes to the lean readers Worker's handler (workers/readers)
// instead of the Next.js route, and every assertion stays the same. This is the "same behavior" test of the Worker for tracking
// and links (and click counts per link), account blocks, unsubscribe in every state, automations and webhooks that unsubscribe
// ends, contact deletion, recommendations' beacons, visits, signup forms. `FLOCKSTACK_READERS_TARGET=worker npm test` runs the whole suite so.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SUITES = ["link-clicks", "tracking", "unsubscribe", "account-blocks", "automations", "webhooks", "website", "contact-delete", "recommendations", "web-analytics", "forms"];

test("the reader suites pass against the lean readers Worker", { timeout: 600_000 }, async () => {
	if (process.env.FLOCKSTACK_READERS_TARGET === "worker") return; // already the whole suite, so nothing to start
	// The runner marks its children (NODE_TEST_CONTEXT) so they report in its own format; this one must print normally.
	const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
	const child = spawn(process.execPath, ["--import", "./tests/setup/register.mjs", "--test", ...SUITES.map((name) => `tests/${name}.test.mjs`)], {
		cwd: ROOT,
		env: { ...environment, FLOCKSTACK_READERS_TARGET: "worker" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const code = await new Promise((resolve) => child.on("close", resolve));
	const summary = /ℹ pass (\d+)\nℹ fail (\d+)/.exec(output);
	assert.equal(code, 0, `${output.split("\n").filter((line) => /✖|AssertionError/.test(line)).slice(0, 20).join("\n")}`);
	assert.ok(summary && Number(summary[1]) > 100, `the suites ran: ${summary?.[0]}`);
});
