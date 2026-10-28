// Which tests (and whether the Next.js build) a pull request needs, from the files it changes. CI runs this on pull requests only;
// pushes to main, the nightly run and manual runs always run everything.
//
//   node scripts/affected-tests.mjs [--base origin/main] [--map test-map.json] [--list file] [--github-output file]
//
// The answer is one of: "all" (the whole suite), "subset" (only the tests listed) or "none" (nothing but documentation, images or
// fonts that no test reads changed). A file it cannot map to a test sends the whole suite: a wrong "subset" would let a break through,
// a wrong "all" only costs time.
//
// How a changed file maps to tests:
//   1. A test file maps to itself.
//   2. A test covers a file when its process loaded it. CI's full runs record that (tests/setup/hooks.mjs, scripts/test-map.mjs) and
//      cache the map; --map reads it. Without a map, or for a test the map lacks, the imports stand in: static, import("..."),
//      `import(\`prefix${x}\`)` (everything under the prefix directory), through the "@/" alias, through the helpers and stubs.
//      The imports reach far more than a test runs (the test app loads the registry, which imports everything), so the map is
//      what makes a subset small.
//   3. Tests that start other processes or build bundles (child_process, esbuild, scripts/build-*) load nothing the map sees, so they run
//      on every change to code.
//   4. Or when it names the file: tests read sources, docs, migrations and budgets as text and call routes by path
//      (readerRoute("app/c/[token]/route.js")), which no import graph sees. A path, a directory's own quoted name and the last two
//      segments of a path count as naming; for data and documents the file name alone does.
//   5. If a third or more of the suite is affected, or the run's files are too foundational (below), everything runs.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Changing one of these runs the whole suite and the build: they shape how every test runs or how everything builds. Keep the
// list in .github/workflows/ci.yml's comment in step.
export const FOUNDATIONAL = [
	/^package(-lock)?\.json$/,
	/^(jsconfig|eslint\.config|next\.config|open-next\.config|postcss\.config|vitest\.collaboration\.config|wrangler|components)\./,
	/^\.github\//,
	/^tests\/setup\//,
	/^tests\/stubs\//,
	/^tests\/helpers\/(app|shallow)\.mjs$/,
	/^scripts\/(test-all|affected-tests)\.mjs$/,
	/^migrations\//,
	/^models\//,
	/^perf-budgets\.json$/,
	/^worker-entry\.mjs$/,
];

// Changing one of these needs the Next.js build, as does any file the app's own code imports. Nothing else does.
const BUILD_ROOTS = [/^app\//, /^components\//, /^public\//, /^proxy\.js$/, /^instrumentation\.js$/];

// Files no test needs unless it names them: prose, images, fonts, the licence.
const INERT = /(\.(md|mdx|txt|png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf)|(^|\/)LICENSE)$/i;

const CODE = /\.(m?js|cjs|jsx|tsx?)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".open-next", ".worker", "dist", ".wrangler"]);
// Past this share of the suite, running it all costs little more than running most of it.
const ALL_AT = 1 / 3;
// Names too common to tell files apart when a test names one without its directory.
// Tests that run other processes or build bundles from the sources: their loads happen out of the map's sight.
const CROSS_CUTTING = /child_process|scripts\/build-|bundle-worker|esbuild|next build/;
const COMMON_NAMES = new Set(["index.js", "page.js", "route.js", "layout.js", "handler.js", "package.json", "README.md"]);

function walk(dir, out = []) {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(rel, out);
		else out.push(rel);
	}
	return out;
}

const read = (rel) => {
	try {
		return readFileSync(join(ROOT, rel), "utf8");
	} catch {
		return "";
	}
};

const IMPORT_FORMS = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*["']([^"']+)["']/g,
	/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\(\s*["']([^"']+)["']\s*\)/g,
];
const TEMPLATE_IMPORT = /\bimport\(\s*`([^`$]*)\$\{/g;

// Every module a file imports, as repository-relative paths, and the directories it imports a computed name from.
function importsOf(rel, files) {
	const text = read(rel);
	const found = new Set();
	const prefixes = new Set();
	const resolve = (spec, isPrefix) => {
		let base;
		if (spec.startsWith("@/")) base = spec.slice(2);
		else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(rel), spec));
		else return;
		if (base.startsWith("../") || base === "." || base === "") return;
		if (isPrefix) {
			const dir = base.endsWith("/") ? base.slice(0, -1) : posix.dirname(base);
			if (dir && dir !== "." && !dir.startsWith("node_modules")) prefixes.add(dir);
			return;
		}
		for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`, `${base}/index.mjs`]) {
			if (files.has(candidate)) {
				found.add(candidate);
				return;
			}
		}
	};
	for (const form of IMPORT_FORMS) for (const match of text.matchAll(form)) resolve(match[1], false);
	for (const match of text.matchAll(TEMPLATE_IMPORT)) resolve(match[1], true);
	return { found, prefixes };
}

// Builds the import graph over every code file once, and each test's reach: files it imports, directly or through others.
function buildGraph(all) {
	const files = new Set(all);
	const codeFiles = all.filter((f) => CODE.test(f));
	const edges = new Map();
	const prefixed = new Map();
	for (const file of codeFiles) {
		const { found, prefixes } = importsOf(file, files);
		edges.set(file, found);
		prefixed.set(file, prefixes);
	}
	const byDir = new Map();
	const under = (dir) => {
		if (!byDir.has(dir)) byDir.set(dir, codeFiles.filter((f) => f.startsWith(`${dir}/`)));
		return byDir.get(dir);
	};
	const reach = (starts) => {
		const seen = new Set();
		const stack = [...starts];
		while (stack.length) {
			const file = stack.pop();
			if (seen.has(file)) continue;
			seen.add(file);
			for (const next of edges.get(file) ?? []) stack.push(next);
			for (const dir of prefixed.get(file) ?? []) for (const next of under(dir)) stack.push(next);
		}
		return seen;
	};
	return { reach, files };
}

function names(text, rel) {
	if (text.includes(rel)) return true;
	const parts = rel.split("/");
	if (parts.length > 1 && text.includes(parts.slice(-2).join("/"))) return true;
	const name = parts.at(-1);
	return !CODE.test(rel) && !COMMON_NAMES.has(name) && text.includes(name);
}

// A directory the test names on its own ("migrations", "docs/"), so everything in it counts as read.
function namesDirectory(text, rel) {
	const parts = rel.split("/");
	for (let depth = 1; depth < parts.length; depth++) {
		const dir = parts.slice(0, depth).join("/");
		if (depth === 1) {
			if (text.includes(`"${dir}"`) || text.includes(`'${dir}'`) || text.includes(`\`${dir}\``) || text.includes(`"${dir}/"`) || text.includes(`'${dir}/'`)) return true;
		} else if (text.includes(`${dir}/"`) || text.includes(`${dir}/'`) || text.includes(`"${dir}"`) || text.includes(`'${dir}'`)) return true;
	}
	return false;
}

export function plan({ changed, deleted = [], map = null }) {
	const all = walk("");
	const tests = all.filter((f) => /^tests\/[^/]+\.test\.mjs$/.test(f)).sort();
	const reasons = [];

	const foundational = [...changed, ...deleted].filter((f) => FOUNDATIONAL.some((re) => re.test(f)));
	if (foundational.length) return { mode: "all", build: true, tests, reasons: [`foundational: ${foundational.slice(0, 5).join(", ")}`] };
	if (!changed.length && !deleted.length) return { mode: "none", build: false, tests: [], reasons: ["nothing changed"] };

	const { reach, files } = buildGraph(all);
	const appEntries = all.filter((f) => CODE.test(f) && BUILD_ROOTS.some((re) => re.test(f)));
	const appReach = reach(appEntries);
	const testReach = new Map();
	for (const test of tests) {
		const imported = reach([test]);
		const support = [...imported].filter((f) => f.startsWith("tests/"));
		const own = read(test);
		let text = own;
		for (const file of support) if (file !== test) text += `\n${read(file)}`;
		// What the test loaded when the map was made, or what it imports when the map lacks it.
		const closure = map?.tests?.[test] ? new Set([...map.tests[test], test]) : imported;
		testReach.set(test, { closure, text, crossCutting: CROSS_CUTTING.test(own) });
	}

	const affected = new Set();
	let build = false;
	for (const file of [...changed, ...deleted]) {
		const exists = files.has(file);
		if (exists && (BUILD_ROOTS.some((re) => re.test(file)) || appReach.has(file))) build = true;
		if (!exists && BUILD_ROOTS.some((re) => re.test(file))) build = true;
		let hit = false;
		if (/^tests\/[^/]+\.test\.mjs$/.test(file)) {
			if (exists) affected.add(file);
			hit = true;
		}
		const runsOnCode = !file.startsWith("tests/") && !INERT.test(file);
		for (const test of tests) {
			const { closure, text, crossCutting } = testReach.get(test);
			if ((exists && closure.has(file)) || names(text, file) || namesDirectory(text, file)) {
				affected.add(test);
				hit = true;
			} else if (crossCutting && runsOnCode) {
				// Runs on every code change, but is no evidence the file is covered: that stays with the loads and the names.
				affected.add(test);
			}
		}
		if (!hit) {
			if (INERT.test(file)) continue;
			return { mode: "all", build: true, tests, reasons: [`no test covers ${file}`] };
		}
	}
	if (!affected.size) return { mode: "none", build, tests: [], reasons: ["only documents or assets no test reads"] };
	if (affected.size >= tests.length * ALL_AT) return { mode: "all", build: true, tests, reasons: [`${affected.size} of ${tests.length} tests affected`] };
	return { mode: "subset", build, tests: [...affected].sort(), reasons };
}

function git(args) {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

export function changedFiles(base) {
	const lines = git(["diff", "--name-status", "--no-renames", `${base}...HEAD`]).split("\n").filter(Boolean);
	const changed = [];
	const deleted = [];
	for (const line of lines) {
		const [status, ...rest] = line.split("\t");
		(status === "D" ? deleted : changed).push(rest.join("\t"));
	}
	return { changed, deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
	const base = arg("--base", "origin/main");
	const mapFile = arg("--map");
	let map = null;
	try {
		if (mapFile) map = JSON.parse(readFileSync(mapFile, "utf8"));
	} catch {
		console.log(`no usable test map at ${mapFile}: falling back to imports`);
	}
	const result = plan({ ...changedFiles(base), map });
	if (arg("--list")) writeFileSync(arg("--list"), `${result.tests.join("\n")}\n`);
	const lines = [`mode=${result.mode}`, `build=${result.build}`, `count=${result.tests.length}`];
	if (arg("--github-output")) appendFileSync(arg("--github-output"), `${lines.join("\n")}\n`);
	console.log(`${lines.join(" ")}  (${result.reasons.join("; ") || "mapped by imports and names"})`);
	if (result.mode === "subset") console.log(result.tests.join("\n"));
}
