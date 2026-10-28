// Turns the files tests/setup/hooks.mjs noted (TEST_MAP_DIR, one file per test process) into the map scripts/affected-tests.mjs reads:
// for every test file, the repository files its process loaded. CI's full runs (push to main, nightly) write it and cache it.
//
//   node scripts/test-map.mjs <TEST_MAP_DIR> <output.json>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("Usage: node scripts/test-map.mjs <TEST_MAP_DIR> <output.json>");

const TEST = /^tests\/[^/]+\.test\.mjs$/;
const tests = new Map();
for (const name of readdirSync(dir)) {
	if (!name.endsWith(".txt")) continue;
	const files = new Set(readFileSync(`${dir}/${name}`, "utf8").split("\n").filter(Boolean));
	// A process runs one test file; one that loads none (the runner itself) says nothing.
	for (const test of [...files].filter((f) => TEST.test(f))) {
		const known = tests.get(test) ?? new Set();
		for (const file of files) if (file !== test) known.add(file);
		tests.set(test, known);
	}
}

mkdirSync(dirname(out), { recursive: true });
const map = { version: 1, generatedAt: new Date().toISOString(), tests: Object.fromEntries([...tests].sort(([a], [b]) => a.localeCompare(b)).map(([test, files]) => [test, [...files].sort()])) };
writeFileSync(out, `${JSON.stringify(map)}\n`);
console.log(`test map: ${tests.size} tests, ${new Set([...tests.values()].flatMap((files) => [...files])).size} files loaded`);
