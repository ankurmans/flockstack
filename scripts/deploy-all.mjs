// Builds FlockStack once, applies the migrations that are missing from each region's database, then deploys the same build
// to each region: its app Worker (flockstack, flockstack-eu), the lean API Worker built from the same source (flockstack-api,
// flockstack-api-eu), the lean readers Worker (flockstack-readers, flockstack-readers-eu: the open pixel, the click redirect, unsubscribe),
// the public pages Worker rendered from that build (flockstack-public, flockstack-public-eu) and the router that
// fronts the domain (flockstack-router, flockstack-router-eu). wrangler.jsonc has the apps, workers/api, workers/readers, workers/public and
// workers/router the others (docs/ARCHITECTURE-WORKERS.md). Deploying the API Worker does not send it any traffic: the router does,
// once API_ENABLED says so (the runbook in the same document).
//   node scripts/deploy-all.mjs [--only us|eu] [--dry-run] [--skip-build] [--skip-router-check] [--baseline 0006]
// --only deploys one region (its database and Workers; the build is still the one build). --dry-run prints every command
// and runs none, and talks to nothing. --skip-build deploys the .open-next folder and workers/public/dist as they are (build .open-next with FLOCKSTACK_CLOUD_BUILD=true).
// Placeholders left in lib/legal.js don't stop it: the legal pages stay hidden until they are filled, and it says which are left.
// The optional Workers (realtime editing, inbound replies) are in no configuration of the repository, so a deploy never names a Worker that
// may not exist. A region that has one says so in FLOCKSTACK_OPTIONAL_WORKERS or optional-workers.json (scripts/optional-workers.mjs,
// docs/OPTIONAL-WORKERS-RUNBOOK.md); then this deploys it too and adds its bindings to the app, API Worker and router for that deploy only.
//
// Order, for each region: the app, then the API Worker and the readers Worker (they ask the app, through a binding, to drop cached pages), then the public
// pages (which point at the files of the build the app now has), then the router (which binds the API and readers Workers and needs them to exist).
// While the app still lists the region's domain (before the cutover) the router is deployed without the domain, on workers.dev only,
// to be tried there; once the app has let the domain go, the router is deployed with it, which keeps it.
// Last, for each region: scripts/check-mcp-auth.mjs asks its address for the OAuth discovery documents, the signing keys and /mcp's 401, the
// things an MCP client needs, and prints a warning if one is wrong. It never stops the run (FLOCKSTACK_API_KEY also lists the tools).
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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLegalTodos } from "../lib/legal.js";
import { getRegionUrls } from "../lib/region.js";
import { readJsonc } from "./bundle-worker.mjs";
import { formatResults, runChecks } from "./check-mcp-auth.mjs";
import { applyOptionalBindings, collaborationVars, collaborationWorkerName, describeOptionalWorkers, hasCollaboration, loadOptionalWorkers, repliesWorkerName } from "./optional-workers.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "migrations");
const TRACKER = "_flockstack_migrations";
const DEFAULT_BASELINE = 6;
const OPTIONAL_CONFIG_NAME = "wrangler.optional.jsonc";

// Names as in wrangler.jsonc: the top-level config is the US deployment, env.eu the EU one.
export const REGIONS = {
	us: {
		worker: "flockstack",
		database: "flockstack",
		wranglerArgs: [],
		apiWorker: "flockstack-api",
		apiArgs: ["--config", "workers/api/wrangler.jsonc"],
		readersWorker: "flockstack-readers",
		readersArgs: ["--config", "workers/readers/wrangler.jsonc"],
		publicWorker: "flockstack-public",
		publicArgs: ["--config", "workers/public/wrangler.jsonc"],
		routerWorker: "flockstack-router",
		routerArgs: ["--config", "workers/router/wrangler.jsonc", "--env", "us"],
		routerStagedArgs: ["--config", "workers/router/wrangler.jsonc"],
		collaborationArgs: ["--config", "workers/collaboration/wrangler.jsonc"],
		repliesArgs: ["--config", "workers/replies/wrangler.jsonc"],
	},
	eu: {
		worker: "flockstack-eu",
		database: "flockstack-eu",
		wranglerArgs: ["--env", "eu"],
		apiWorker: "flockstack-api-eu",
		apiArgs: ["--config", "workers/api/wrangler.jsonc", "--env", "eu"],
		readersWorker: "flockstack-readers-eu",
		readersArgs: ["--config", "workers/readers/wrangler.jsonc", "--env", "eu"],
		publicWorker: "flockstack-public-eu",
		publicArgs: ["--config", "workers/public/wrangler.jsonc", "--env", "eu"],
		routerWorker: "flockstack-router-eu",
		routerArgs: ["--config", "workers/router/wrangler.jsonc", "--env", "eu"],
		routerStagedArgs: ["--config", "workers/router/wrangler.jsonc", "--env", "eu-staged"],
		collaborationArgs: ["--config", "workers/collaboration/wrangler.jsonc", "--env", "eu"],
		repliesArgs: ["--config", "workers/replies/wrangler.jsonc", "--env", "eu"],
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

// This script deploys FlockStack Cloud, which keeps images in R2: its builds (the app's, the API Worker's that Wrangler runs at each deploy) leave the
// S3, CloudFront and Vercel Blob clients out (next.config.mjs, scripts/build-api-worker.mjs). FLOCKSTACK_CLOUD_BUILD=false in the environment keeps them.
export function getBuildEnv(env = process.env) {
	return { ...env, FLOCKSTACK_CLOUD_BUILD: env.FLOCKSTACK_CLOUD_BUILD ?? "true" };
}

function show(command, args) {
	console.log(`$ ${[command, ...args].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ")}`);
}

function run(command, args, { isDryRun, capture = false }) {
	show(command, args);
	if (isDryRun) return "";
	const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", env: getBuildEnv() });
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

// A key only opens its own region (lib/api-key-tokens.js): mc_eu_ in the EU, mc_ in the US.
function getKeyForRegion(region, key = process.env.FLOCKSTACK_API_KEY) {
	if (!key) return undefined;
	return key.startsWith("mc_eu_") === (region === "eu") ? key : undefined;
}

// After a region's router is deployed: can an MCP client still connect to its address (scripts/check-mcp-auth.mjs)? A failure is a warning
// and never stops the run: the deploy is done, and the warning says what to look at. The Workers take a moment to be served everywhere,
// so a failed check is run once more after a pause.
export async function checkMcpAuth(region, { isDryRun, checkMcp = runChecks, pauseMs = 5000 }) {
	const url = getRegionUrls()[region];
	console.log(`\n==> Check sign-in for MCP clients: ${url}`);
	if (isDryRun) {
		console.log(`    Would run: node scripts/check-mcp-auth.mjs ${url}`);
		return;
	}
	const apiKey = getKeyForRegion(region);
	try {
		let results = await checkMcp({ baseUrl: url, apiKey });
		if (results.some(({ ok }) => !ok)) {
			await new Promise((resolve) => setTimeout(resolve, pauseMs));
			results = await checkMcp({ baseUrl: url, apiKey });
		}
		console.log(formatResults(results));
		const failed = results.filter(({ ok }) => !ok).length;
		if (failed > 0) console.warn(`WARNING: ${failed} of ${results.length} checks of ${url} failed. The deploy is done; MCP clients may not be able to connect. Run: node scripts/check-mcp-auth.mjs ${url} (docs/AUTH-ROTATION.md).`);
		else console.log(`    OK${apiKey ? "" : " (set FLOCKSTACK_API_KEY to also list the tools with a key)"}.`);
	} catch (error) {
		console.warn(`WARNING: could not check ${url}: ${error.message}`);
	}
}

// The deploy of a Worker that may need the region's optional bindings: with none to add it is the plain command; with some, Wrangler is
// given a copy of the configuration next to the original (paths in it are relative to its folder) that has them, removed afterwards.
// A dry run prints the copy's name and what it adds, and writes nothing.
export function deployWithOptional(label, kind, args, region, settings, options) {
	const configIndex = args.indexOf("--config");
	const configPath = configIndex === -1 ? "wrangler.jsonc" : args[configIndex + 1];
	const original = readJsonc(readFileSync(join(ROOT, configPath), "utf8"));
	const { config, added } = applyOptionalBindings(original, kind, region, settings);
	if (added.length === 0) return run("npx", ["wrangler", "deploy", ...args], options);
	const copyPath = join(dirname(configPath), OPTIONAL_CONFIG_NAME);
	for (const line of added) console.log(`    + ${line} (${label}, this deploy only)`);
	const copyArgs = configIndex === -1 ? ["--config", copyPath, ...args] : args.map((part, index) => (index === configIndex + 1 ? copyPath : part));
	if (options.isDryRun) return run("npx", ["wrangler", "deploy", ...copyArgs], options);
	writeFileSync(join(ROOT, copyPath), JSON.stringify(config, null, "\t"));
	try {
		return run("npx", ["wrangler", "deploy", ...copyArgs], options);
	} finally {
		rmSync(join(ROOT, copyPath), { force: true });
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

export async function main(argv = process.argv.slice(2), { migrationsDir = MIGRATIONS_DIR, legalTodos = getLegalTodos(), fetchImpl = fetch, wranglerConfig, checkMcp = runChecks, checkPauseMs, optionalWorkers = loadOptionalWorkers() } = {}) {
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

	console.log("\n==> Optional Workers");
	for (const region of regions) console.log(`    ${region}: ${describeOptionalWorkers(optionalWorkers, region)}.`);

	console.log("\n==> Build");
	if (options.skipBuild) console.log("    Skipped (--skip-build): deploying .open-next and workers/public/dist as they are (Wrangler still builds the API Worker).");
	else {
		// A stale .next can make the build panic (next.config.mjs, turbopackServerSideNestedAsyncChunking).
		if (!options.isDryRun) rmSync(join(ROOT, ".next"), { recursive: true, force: true });
		console.log("    $ rm -rf .next");
		run("npx", ["opennextjs-cloudflare", "build"], options);
		console.log("\n==> Render the public pages");
		run("npm", ["run", "render:public"], options);
		// Wrangler builds it again at each deploy (workers/api/wrangler.jsonc); here a failure stops the run before any migration.
		console.log("\n==> Build the API Worker");
		run("npm", ["run", "build:api"], options);
		console.log("\n==> Build the readers Worker");
		run("npm", ["run", "build:readers"], options);
		// A Worker whose script grew past its budget is a slower cold start for everybody: stop before anything is changed.
		// The app's upload is the bundle Wrangler builds, so it is made here too (scripts/bundle-worker.mjs).
		console.log("\n==> Size budgets");
		run("npm", ["run", "bundle:app"], options);
		run("npm", ["run", "perf:budget", "--", "--require-app"], options);
	}

	for (const region of regions) migrate(region, files, options);
	const deployed = [];

	for (const region of regions) {
		const { worker, wranglerArgs, apiWorker, apiArgs, readersWorker, readersArgs, publicWorker, publicArgs, routerWorker, routerArgs, routerStagedArgs, collaborationArgs, repliesArgs } = REGIONS[region];
		// First, so the bindings the app, the API Worker and the router are about to get point at the current code.
		if (hasCollaboration(optionalWorkers, region)) {
			const name = collaborationWorkerName(region);
			deployed.push(name);
			console.log(`\n==> Deploy: ${name} (optional; its flag is ${optionalWorkers[region].collaboration.state === "enabled" ? "on" : "off"})`);
			run("npx", ["wrangler", "deploy", ...collaborationArgs, ...collaborationVars(optionalWorkers, region)], options);
		}
		console.log(`\n==> Deploy: ${worker}`);
		deployWithOptional(worker, "app", wranglerArgs, region, optionalWorkers, options);
		console.log(`\n==> Deploy: ${apiWorker} (it gets no traffic until the router's API_ENABLED says so)`);
		deployWithOptional(apiWorker, "api", apiArgs, region, optionalWorkers, options);
		console.log(`\n==> Deploy: ${readersWorker} (it gets no traffic until the router's READERS_ENABLED says so)`);
		run("npx", ["wrangler", "deploy", ...readersArgs], options);
		console.log(`\n==> Deploy: ${publicWorker}`);
		run("npx", ["wrangler", "deploy", ...publicArgs], options);
		const isStaged = appHoldsDomain(region, wranglerConfig);
		console.log(`\n==> Deploy: ${routerWorker}${isStaged ? " (staged: workers.dev only, the domain is still the app's)" : ""}`);
		deployWithOptional(routerWorker, "router", isStaged ? routerStagedArgs : routerArgs, region, optionalWorkers, options);
		if (optionalWorkers[region].replies) {
			const name = repliesWorkerName(region);
			deployed.push(name);
			console.log(`\n==> Deploy: ${name} (optional; mail reaches it only through Email Routing)`);
			run("npx", ["wrangler", "deploy", ...repliesArgs], options);
		}
		await checkMcpAuth(region, { isDryRun: options.isDryRun, checkMcp, pauseMs: checkPauseMs });
	}
	const names = regions.flatMap((region) => [REGIONS[region].worker, REGIONS[region].apiWorker, REGIONS[region].readersWorker, REGIONS[region].publicWorker, REGIONS[region].routerWorker]);
	console.log(options.isDryRun ? "\nDry run done." : `\nDeployed ${[...names, ...deployed].join(", ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
	} catch (error) {
		console.error(`\n${error.message}`);
		process.exit(1);
	}
}
