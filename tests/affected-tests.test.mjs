import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { plan } from "../scripts/affected-tests.mjs";

// Which tests and whether the build a pull request needs (scripts/affected-tests.mjs, .github/workflows/ci.yml). A wrong "subset" lets
// a break through to main, so what must run everything is pinned here: a test the mapper skipped is a failure only the main run finds.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ALL_TESTS = readdirSync(`${ROOT}tests`).filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`);
// A map in which no test loads anything, except the ones given.
// Paths nothing names: built here so this file does not name them either.
const UNNAMED = ["zz", "unnamed", "dir"].join("-");
const unnamed = (name) => `${UNNAMED}/${name.split(".").join("-")}.${name.split(".").at(-1)}`;
const mapOf = (loads = {}) => ({ tests: Object.fromEntries(ALL_TESTS.map((test) => [test, loads[test] ?? []])) });

describe("affected tests", () => {
	test("a foundational file runs everything and the build", () => {
		for (const file of ["package.json", "package-lock.json", "next.config.mjs", ".github/workflows/ci.yml", "tests/setup/hooks.mjs", "migrations/0001_init.sql", "models/Campaign.js", "perf-budgets.json"]) {
			const result = plan({ changed: [file] });
			assert.equal(result.mode, "all", file);
			assert.equal(result.build, true, file);
			assert.equal(result.tests.length, ALL_TESTS.length, file);
		}
	});

	test("a changed test file runs itself and does not need the build", () => {
		const result = plan({ changed: ["tests/briefings-engine.test.mjs"], map: mapOf() });
		assert.notEqual(result.mode, "none");
		assert.ok(result.tests.includes("tests/briefings-engine.test.mjs"));
		assert.equal(result.build, false);
	});

	test("a document nothing reads (in a directory no test names) runs no tests and no build", () => {
		const result = plan({ changed: [unnamed("a.md")], map: mapOf() });
		assert.equal(result.mode, "none");
		assert.equal(result.build, false);
		assert.deepEqual(result.tests, []);
	});

	test("a code file no test covers or names runs everything rather than guessing", () => {
		const result = plan({ changed: [unnamed("code.js")], map: mapOf() });
		assert.equal(result.mode, "all");
		assert.match(result.reasons[0], /no test covers/);
	});

	test("a deleted file nothing names runs everything", () => {
		const result = plan({ changed: [], deleted: [unnamed("gone.js")], map: mapOf() });
		assert.equal(result.mode, "all");
	});

	test("with a map, a file maps to the tests that loaded it, plus the tests that run other processes", () => {
		const loaded = "tests/briefings-engine.test.mjs";
		const result = plan({ changed: ["lib/section-icons.js"], map: mapOf({ [loaded]: ["lib/section-icons.js"] }) });
		assert.equal(result.mode, "subset");
		assert.ok(result.tests.includes(loaded));
		assert.ok(result.tests.length < ALL_TESTS.length / 3, `${result.tests.length} tests`);
		// The tests that build bundles or spawn processes load nothing the map sees, so any code change runs them.
		assert.ok(result.tests.includes("tests/readers-worker-build.test.mjs"));
	});

	test("the build runs for code the app reaches and not for the rest", () => {
		assert.equal(plan({ changed: ["proxy.js"], map: mapOf() }).build, true);
		assert.equal(plan({ changed: ["tests/briefings-engine.test.mjs"], map: mapOf() }).build, false);
		assert.equal(plan({ changed: ["scripts/narrow-bundle.mjs"], map: mapOf() }).build, false);
	});

	test("the command line writes the outputs CI reads", () => {
		const dir = mkdtempSync(join(tmpdir(), "affected-"));
		const out = join(dir, "output.txt");
		const list = join(dir, "tests.txt");
		writeFileSync(out, "");
		const run = spawnSync("node", ["scripts/affected-tests.mjs", "--base", "HEAD", "--list", list, "--github-output", out], { cwd: ROOT, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		// Against itself nothing changed.
		assert.match(run.stdout, /mode=none build=false count=0/);
	});
});
