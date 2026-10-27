// Fails when a Worker's script is bigger than its budget (perf-budgets.json): the app's handler and upload, the API Worker, the readers Worker, the
// router and the public pages Worker. A script's size is what a new isolate has to load before it answers anything (the app's was most of
// a cold start), so a size that creeps up is a cold start that does.
//   node scripts/perf-budget.mjs [--require-app] [--json]
// The API and readers Workers are built when they are missing. The app's files exist after `npx opennextjs-cloudflare build` (and its bundle step);
// without them the app's budgets are skipped, unless --require-app (deploy-all passes it, after building).
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function readBudgets(root = ROOT) {
	return JSON.parse(readFileSync(join(root, "perf-budgets.json"), "utf8")).budgets;
}

function loadEsbuild(root) {
	const require = createRequire(join(root, "package.json"));
	return createRequire(join(dirname(require.resolve("wrangler/package.json")), "package.json"))("esbuild");
}

// The bundled and minified size of a module: what the router and the public Worker ship, apart from their data.
export function bundleSize(entry, root = ROOT, external = []) {
	const result = loadEsbuild(root).buildSync({ entryPoints: [join(root, entry)], bundle: true, write: false, external, format: "esm", minify: true, logLevel: "silent" });
	return result.outputFiles[0].contents.length;
}

// Each budget with its measured size (null when its file is missing) and whether it holds. measure: how to get a size, for tests.
export function checkBudgets(budgets, { root = ROOT, measure = null, only = null } = {}) {
	return Object.entries(budgets)
		.filter(([name]) => !only || only.includes(name))
		.map(([name, budget]) => {
			let bytes = null;
			if (measure) bytes = measure(name, budget);
			else if (budget.bundle) bytes = bundleSize(budget.bundle, root, budget.external ?? []);
			else if (existsSync(join(root, budget.file))) bytes = statSync(join(root, budget.file)).size;
			return { name, label: budget.label, file: budget.file ?? budget.bundle, maxBytes: budget.maxBytes, bytes, isMissing: bytes === null, isOver: bytes !== null && bytes > budget.maxBytes };
		});
}

export function formatReport(results) {
	const mb = (bytes) => (bytes >= 1e5 ? `${(bytes / 1e6).toFixed(2)} MB` : `${(bytes / 1e3).toFixed(1)} KB`);
	return results
		.map(({ label, bytes, maxBytes, isMissing, isOver }) => `${isOver ? "OVER   " : isMissing ? "missing" : "ok     "} ${label.padEnd(58)} ${isMissing ? "-".padStart(10) : mb(bytes).padStart(10)} of ${mb(maxBytes)}`)
		.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const requireApp = process.argv.includes("--require-app");
	const budgets = readBudgets();
	if (!existsSync(join(ROOT, budgets["api-worker"].file))) {
		const { buildApiWorker } = await import("./build-api-worker.mjs");
		await buildApiWorker();
	}
	if (budgets["readers-worker"] && !existsSync(join(ROOT, budgets["readers-worker"].file))) {
		const { buildReadersWorker } = await import("./build-readers-worker.mjs");
		await buildReadersWorker();
	}
	if (budgets["collaboration-worker"] && !existsSync(join(ROOT, budgets["collaboration-worker"].file))) { const { buildCollaborationWorker } = await import("./build-collaboration-worker.mjs"); await buildCollaborationWorker(); }
	const results = checkBudgets(budgets);
	if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
	else console.log(formatReport(results));
	const over = results.filter(({ isOver }) => isOver);
	const missing = results.filter(({ isMissing, name }) => isMissing && (requireApp || !name.startsWith("app-")));
	if (over.length > 0) {
		console.error(`\n${over.map(({ label }) => label).join(", ")}: over budget. Find what grew (docs/PERFORMANCE.md), or raise the budget in perf-budgets.json with the reason.`);
		process.exit(1);
	}
	if (missing.length > 0) {
		console.error(`\nNot built: ${missing.map(({ file }) => file).join(", ")}.`);
		process.exit(1);
	}
}
