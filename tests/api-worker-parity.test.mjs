import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The suites that go through /api/v1, /mcp and the OAuth endpoints, run again with FLOCKSTACK_API_TARGET=worker: the requests go to
// the lean API Worker's fetch handler (workers/api) instead of the Next.js route handlers, and every assertion stays the same. This is
// the "same behavior" test of the Worker: the REST API with all its actions, MCP (tools, errors, the SDK client), OAuth (discovery,
// registration, tokens, consent, revocation), keys and limits, and agent safety (scopes, per-newsletter keys, caps, expiry, approvals and the 202, the activity log, OAuth access levels). `FLOCKSTACK_API_TARGET=worker npm test` runs the whole suite so.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SUITES = ["api", "mcp", "oauth", "parity", "api-keys", "account-limits", "account-blocks", "free-plans", "tags-fields", "agent-keys", "agent-approvals", "agent-scopes", "agent-activity", "content-calendar"];

test("the API, MCP and OAuth suites pass against the lean API Worker", { timeout: 600_000 }, async () => {
	if (process.env.FLOCKSTACK_API_TARGET === "worker") return; // already the whole suite, so nothing to start
	// The runner marks its children (NODE_TEST_CONTEXT) so they report in its own format; this one must print normally.
	const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
	const child = spawn(process.execPath, ["--import", "./tests/setup/register.mjs", "--test", ...SUITES.map((name) => `tests/${name}.test.mjs`)], {
		cwd: ROOT,
		env: { ...environment, FLOCKSTACK_API_TARGET: "worker" },
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
