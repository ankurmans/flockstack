import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApiWorker } from "../scripts/build-api-worker.mjs";
import { buildReadersWorker } from "../scripts/build-readers-worker.mjs";
import { buildBriefingsWorker } from "../scripts/build-briefings-worker.mjs";
import { buildCollaborationWorker } from "../scripts/build-collaboration-worker.mjs";
import { checkBudgets, formatReport, readBudgets } from "../scripts/perf-budget.mjs";

// scripts/perf-budget.mjs: the Workers' script sizes against perf-budgets.json. A new isolate loads its whole script before it
// answers, so these are cold starts in bytes.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const budgets = readBudgets();

describe("the budgets", () => {
	test("name every Worker script, each with a limit a little above what it measured", () => {
		assert.deepEqual(Object.keys(budgets).sort(), ["api-worker", "app-handler", "app-upload", "briefings-worker", "collaboration-worker", "public-handler", "readers-worker", "replies-worker", "router"]);
		for (const [name, budget] of Object.entries(budgets)) {
			assert.ok(budget.maxBytes > 0 && budget.label && (budget.file || budget.bundle), name);
			if (budget.measured) {
				assert.ok(budget.maxBytes >= budget.measured, `${name}: the limit is under what it measured`);
				assert.ok(budget.maxBytes <= budget.measured * 1.8, `${name}: the limit is ${(budget.maxBytes / budget.measured).toFixed(2)} times what it measured: tighten it`);
			}
		}
	});

	test("the router and the public pages Worker, bundled, and the API and readers Workers, built, are inside theirs", async () => {
		await buildReadersWorker();
		await buildCollaborationWorker();
		await buildBriefingsWorker();
		for (const result of checkBudgets(budgets, { only: ["router", "public-handler", "readers-worker", "replies-worker", "collaboration-worker", "briefings-worker"] })) {
			assert.equal(result.isMissing, false, result.name);
			assert.equal(result.isOver, false, `${result.label} is ${result.bytes} bytes, over ${result.maxBytes}`);
		}
	});

	// The budget is the FlockStack Cloud build's (FLOCKSTACK_CLOUD_BUILD=true: no S3, CloudFront or Vercel Blob client), built apart so the
	// API Worker the other tests load stays the plain one.
	test("the API Worker, built as the Cloud build, is inside its", async () => {
		const original = process.env.FLOCKSTACK_CLOUD_BUILD;
		const folder = mkdtempSync(join(tmpdir(), "perf-budget-"));
		process.env.FLOCKSTACK_CLOUD_BUILD = "true";
		try {
			const { bytes } = await buildApiWorker({ outFile: join(folder, "index.js") });
			assert.ok(bytes <= budgets["api-worker"].maxBytes, `API Worker is ${bytes} bytes, over ${budgets["api-worker"].maxBytes}`);
		} finally {
			if (original === undefined) delete process.env.FLOCKSTACK_CLOUD_BUILD;
			else process.env.FLOCKSTACK_CLOUD_BUILD = original;
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test("the app's handler and upload are inside theirs when a build is there", { skip: !existsSync(join(ROOT, budgets["app-handler"].file)) && "no OpenNext build in this checkout" }, () => {
		for (const result of checkBudgets(budgets, { only: ["app-handler", "app-upload"] })) {
			if (result.isMissing) continue;
			assert.equal(result.isOver, false, `${result.label} is ${result.bytes} bytes, over ${result.maxBytes}`);
		}
	});
});

describe("checking", () => {
	const fake = { a: { label: "A", file: "a.js", maxBytes: 100 }, b: { label: "B", file: "b.js", maxBytes: 100 }, c: { label: "C", file: "c.js", maxBytes: 100 } };
	const sizes = { a: 99, b: 101, c: null };

	test("an exact size is inside, one byte more is over, and a file that is not there is missing, not over", () => {
		const results = checkBudgets(fake, { measure: (name) => sizes[name] });
		assert.deepEqual(results.map(({ name, isOver, isMissing }) => [name, isOver, isMissing]), [["a", false, false], ["b", true, false], ["c", false, true]]);
		assert.equal(checkBudgets({ x: { label: "X", file: "x", maxBytes: 5 } }, { measure: () => 5 })[0].isOver, false);
	});

	test("only asks for the Workers it was told to", () => {
		assert.deepEqual(checkBudgets(fake, { measure: () => 1, only: ["b"] }).map(({ name }) => name), ["b"]);
	});

	test("the report says which are over and which are missing", () => {
		const report = formatReport(checkBudgets(fake, { measure: (name) => sizes[name] }));
		assert.match(report, /^ok +A/m);
		assert.match(report, /^OVER +B/m);
		assert.match(report, /^missing +C/m);
	});
});
