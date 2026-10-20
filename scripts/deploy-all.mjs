// Builds FlockStack once, applies the migrations that are missing from each region's database, then deploys the same build
// to each region: its app Worker (flockstack, flockstack-eu), the public pages Worker rendered from that build
// (flockstack-public, flockstack-public-eu) and the router that fronts the domain (flockstack-router, flockstack-router-eu).
// wrangler.jsonc has the apps, workers/public and workers/router the others (docs/ARCHITECTURE-WORKERS.md).
//   node scripts/deploy-all.mjs [--only us|eu] [--dry-run] [--skip-build] [--skip-router-check] [--baseline 0006]
// --only deploys one region (its database and Workers; the build is still the one build). --dry-run prints every command
// and runs none, and talks to nothing. --skip-build deploys the .open-next folder and workers/public/dist as they are.
// Placeholders left in lib/legal.js don't stop it: the legal pages stay hidden until they are filled, and it says which are left.
//
// Order, for each region: the app, then the public pages (which point at the files of the build the app now has), then the router.
// The website Worker (flockstack-website) is the website repository's and is deployed from there, before anything here.
// A custom domain is one Worker's at a time, and `wrangler deploy` of the app takes it back or drops it according to the routes
// in wrangler.jsonc. So the run first checks that the domain and the file agree: when the router answers the domain's
// /__router/health, wrangler.jsonc must no longer list the domain (or the deploy would take it from the router); when it does
// not, wrangler.jsonc must list it (or the deploy would leave the domain with no Worker). The runbook's cutover keeps them in step
// (docs/ARCHITECTURE-WORKERS.md). --skip-router-check goes on without the check.
//
// Migrations: a database keeps the names of the files it has had in the table _flockstack_migrations (Wrangler's own
// migrations tracker isn't used here). A run applies, in order, the files in migrations/ that aren't in it, each in one
// command with its own record, so running again applies only what is new. The first run on a database with no such
// table records the files up to --baseline (0006 by default: they were applied by hand) without running them; pass
// --baseline 0 for a database that has none of them. Every migration is applied before the first deploy, so a failure
// stops the run with no Worker changed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLegalTodos } from "../lib/legal.js";
import { getRegionUrls } from "../lib/region.js";
import { readJsonc } from "./bundle-worker.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "migrations");
const TRACKER = "_flockstack_migrations";
const DEFAULT_BASELINE = 6;

// Names as in wrangler.jsonc: the top-level config is the US deployment, env.eu the EU one.
export const REGIONS = {
	us: {
		worker: "flockstack",
		database: "flockstack",
		wranglerArgs: [],
		publicWorker: "flockstack-public",
		publicArgs: ["--config", "workers/public/wrangler.jsonc"],
		routerWorker: "flockstack-router",
		routerArgs: ["--config", "workers/router/wrangler.jsonc", "--env", "us"],
	},
	eu: {
		worker: "flockstack-eu",
		database: "flockstack-eu",
		wranglerArgs: ["--env", "eu"],
		publicWorker: "flockstack-public-eu",
		publicArgs: ["--config", "workers/public/wrangler.jsonc", "--env", "eu"],
		routerWorker: "flockstack-router-eu",
		routerArgs: ["--config", "workers/router/wrangler.jsonc", "--env", "eu"],
	},
};

export function parseArgs(argv) {
	const options = { only: null, isDryRun: false, skipBuild: false, skipRouterCheck: false, baseline: DEFAULT_BASELINE };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--dry-run") options.isDryRun = true;
		else if (argument === "--skip-build") options.skipBuild = true;
		else if (argument === "--skip-router-check") options.skipRouterCheck = true;
		else if (argument === "--only") options.only = argv[++index];
		else if (argument === "--baseline") options.baseline = Number.parseInt(argv[++index], 10);
		else throw new Error(`Unknown option ${argument}. Options: --only us|eu, --dry-run, --skip-build, --skip-router-check, --baseline <number>.`);
	}
	if (options.only !== null && !Object.hasOwn(REGIONS, options.only)) throw new Error("--only takes us or eu.");
	if (!Number.isInteger(options.baseline) || options.baseline < 0) throw new Error("--baseline takes a migration number such as 0006, or 0.");
	return options;
}

export function listMigrations(dir = MIGRATIONS_DIR) {
	return readdirSync(dir)
		.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
		.sort();
}

export function getMigrationNumber(name) {
	return Number.parseInt(name.slice(0, 4), 10);
}

// What a database without a tracker is taken to have: the files up to the baseline, applied by hand.
export function getBaselineFiles(files, baseline) {
	return files.filter((name) => getMigrationNumber(name) <= baseline);
}

export function getPendingFiles(files, applied) {
	const done = new Set(applied);
	return files.filter((name) => !done.has(name));
}

function toStatement(sql) {
	const text = sql.trim();
	if (!text.endsWith(";")) throw new Error("A migration has to end with a semicolon.");
	return text;
}

// The migration and its record, in the one command: either both happen or the run stops on the error.
export function buildMigrationSql(name, sql, now = new Date()) {
	return `${toStatement(sql)}\nINSERT OR IGNORE INTO ${TRACKER} (name, applied_at) VALUES ('${name}', '${now.toISOString()}');\n`;
}

export function buildBaselineSql(names, now = new Date()) {
	const rows = names.map((name) => `('${name}', 'baseline ${now.toISOString()}')`);
	return `${createTrackerSql()}${rows.length > 0 ? ` INSERT OR IGNORE INTO ${TRACKER} (name, applied_at) VALUES ${rows.join(", ")};` : ""}`;
}

export function createTrackerSql() {
	return `CREATE TABLE IF NOT EXISTS ${TRACKER} (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);`;
}

// Wrangler's --json output: a list with one entry per statement, each holding its rows in results.
export function parseRows(output) {
	const start = /\[\s*\{\s*"results"/.exec(output)?.index ?? output.indexOf("[");
	if (start === -1) throw new Error(`No JSON in Wrangler's answer: ${output.slice(0, 200)}`);
	return JSON.parse(output.slice(start)).flatMap((entry) => entry.results ?? []);
}

function show(command, args) {
	console.log(`$ ${[command, ...args].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ")}`);
}

function run(command, args, { isDryRun, capture = false }) {
	show(command, args);
	if (isDryRun) return "";
	const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit" });
	if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed${result.status === null ? ` (${result.signal})` : ` with exit code ${result.status}`}.`);
	return result.stdout ?? "";
}

function d1(region, flags, options) {
	const { database, wranglerArgs } = REGIONS[region];
	return run("npx", ["wrangler", "d1", "execute", database, "--remote", "--yes", ...wranglerArgs, ...flags], options);
}

function query(region, sql, options) {
	return d1(region, ["--json", "--command", sql], { ...options, capture: true });
}

function migrate(region, files, options) {
	console.log(`\n==> Migrations: ${REGIONS[region].database}`);
	const baseline = getBaselineFiles(files, options.baseline);
	if (options.isDryRun) {
		console.log(
			`    Dry run: assumes the database has ${TRACKER} with ${baseline.length} files recorded (${baseline.at(-1) ?? "none"} and before). Without the table, a real run creates it and records them first, without running them.`
		);
	}
	const tables = query(region, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${TRACKER}';`, options);
	const hasTracker = options.isDryRun || parseRows(tables).length > 0;
	d1(region, ["--command", hasTracker ? createTrackerSql() : buildBaselineSql(baseline)], options);
	const recorded = query(region, `SELECT name FROM ${TRACKER};`, options);
	const applied = options.isDryRun ? baseline : parseRows(recorded).map(({ name }) => name);
	const pending = getPendingFiles(files, applied);
	if (pending.length === 0) console.log("    Nothing to apply.");
	const folder = mkdtempSync(join(tmpdir(), "flockstack-migration-"));
	try {
		for (const name of pending) {
			const file = join(folder, name);
			writeFileSync(file, buildMigrationSql(name, readFileSync(join(options.migrationsDir, name), "utf8")));
			console.log(`    Applying ${name}`);
			d1(region, ["--file", file], options);
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

// Whether wrangler.jsonc lists the region's domain as a route of the app Worker.
export function appHoldsDomain(region, config = readJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"))) {
	const host = new URL(getRegionUrls()[region]).hostname;
	const routes = region === "eu" ? config.env?.eu?.routes : config.routes;
	return (routes ?? []).some((route) => (typeof route === "string" ? route : route.pattern) === host);
}

// Whether the region's domain is answered by the router: its health path says so in x-served-by. The domain is the one in
// lib/region.js (REGION_URL_US and REGION_URL_EU can name another).
export async function isRouterLive(region, fetchImpl = fetch) {
	try {
		const response = await fetchImpl(`${getRegionUrls()[region]}/__router/health`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
		await response.arrayBuffer();
		return response.status === 200 && response.headers.get("x-served-by") === "router";
	} catch {
		return false;
	}
}

export async function main(argv = process.argv.slice(2), { migrationsDir = MIGRATIONS_DIR, legalTodos = getLegalTodos(), fetchImpl = fetch, wranglerConfig } = {}) {
	const options = { ...parseArgs(argv), migrationsDir };
	const regions = options.only ? [options.only] : Object.keys(REGIONS);
	const files = listMigrations(migrationsDir);
	if (options.isDryRun) console.log("Dry run: nothing below is executed.\n");

	// Some placeholders can only be filled once this deploy is live (SERVICES_LIVE_CONFIRMED), so they never stop it.
	if (legalTodos.length > 0) {
		console.log(`Legal pages stay hidden until these are filled in lib/legal.js: ${legalTodos.map(([name]) => name).join(", ")}.\n`);
	}

	console.log("==> Router check");
	if (options.skipRouterCheck) console.log("    Skipped (--skip-router-check).");
	for (const region of options.skipRouterCheck ? [] : regions) {
		const url = `${getRegionUrls()[region]}/__router/health`;
		if (options.isDryRun) {
			console.log(`    Would ask ${url} for x-served-by: router.`);
			continue;
		}
		const isLive = await isRouterLive(region, fetchImpl);
		const holds = appHoldsDomain(region, wranglerConfig);
		if (isLive && holds) {
			throw new Error(
				`${url} is answered by the router, but wrangler.jsonc still lists that domain for the app, and deploying the app would take it back from the router. Take the route out of wrangler.jsonc first (docs/ARCHITECTURE-WORKERS.md, Cutover), or pass --skip-router-check.`
			);
		}
		if (!isLive && !holds) {
			throw new Error(
				`${url} is not answered by the router, and wrangler.jsonc no longer lists that domain for the app, so deploying the app would leave it with no Worker. Move the domain to the router first (docs/ARCHITECTURE-WORKERS.md, Cutover), or pass --skip-router-check.`
			);
		}
		console.log(`    ${getRegionUrls()[region]}: ${isLive ? "served by the router, and not a route of the app" : "still the app's own route (no router yet)"}.`);
	}

	console.log("\n==> Build");
	if (options.skipBuild) console.log("    Skipped (--skip-build): deploying .open-next and workers/public/dist as they are.");
	else {
		// A stale .next can make the build panic (next.config.mjs, turbopackServerSideNestedAsyncChunking).
		if (!options.isDryRun) rmSync(join(ROOT, ".next"), { recursive: true, force: true });
		console.log("    $ rm -rf .next");
		run("npx", ["opennextjs-cloudflare", "build"], options);
		console.log("\n==> Render the public pages");
		run("npm", ["run", "render:public"], options);
	}

	for (const region of regions) migrate(region, files, options);

	for (const region of regions) {
		const { worker, wranglerArgs, publicWorker, publicArgs, routerWorker, routerArgs } = REGIONS[region];
		console.log(`\n==> Deploy: ${worker}`);
		run("npx", ["wrangler", "deploy", ...wranglerArgs], options);
		console.log(`\n==> Deploy: ${publicWorker}`);
		run("npx", ["wrangler", "deploy", ...publicArgs], options);
		console.log(`\n==> Deploy: ${routerWorker}`);
		run("npx", ["wrangler", "deploy", ...routerArgs], options);
	}
	const names = regions.flatMap((region) => [REGIONS[region].worker, REGIONS[region].publicWorker, REGIONS[region].routerWorker]);
	console.log(options.isDryRun ? "\nDry run done." : `\nDeployed ${names.join(", ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
	} catch (error) {
		console.error(`\n${error.message}`);
		process.exit(1);
	}
}
