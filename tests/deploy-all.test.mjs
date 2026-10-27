import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	REGIONS,
	appHoldsDomain,
	buildBaselineSql,
	buildMigrationSql,
	getBaselineFiles,
	getPendingFiles,
	isRouterLive,
	listMigrations,
	main,
	parseArgs,
	parseRows,
} from "../scripts/deploy-all.mjs";
import { parseOptionalWorkers } from "../scripts/optional-workers.mjs";

// scripts/deploy-all.mjs: one build, the missing migrations on each region's database, then each region's app, public pages and
// router. The flow runs against stand-ins for npx and npm that keep each D1 database in a SQLite file and write down every call, and
// a stand-in for fetch (the router's health check), so nothing reaches Cloudflare.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Stands in for `npx`: wrangler d1 execute against a SQLite file per database, deploys and builds as log lines.
const FAKE_NPX = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
if (args[0] === "opennextjs-cloudflare") { log({ build: true, cloudBuild: process.env.FLOCKSTACK_CLOUD_BUILD }); process.exit(0); }
if (args[0] === "wrangler" && args[1] === "deploy") {
	// A copy of a configuration made for this deploy (scripts/optional-workers.mjs) is read now: it is removed once the deploy is over.
	const at = args.indexOf("--config");
	const used = at === -1 ? null : args[at + 1];
	log({ deploy: args.slice(2), config: used && used.endsWith("wrangler.optional.jsonc") ? JSON.parse(readFileSync(used, "utf8")) : null });
	process.exit(process.env.FAKE_FAIL_DEPLOY && args.join(" ").includes(process.env.FAKE_FAIL_DEPLOY) ? 1 : 0);
}
if (args[0] === "wrangler" && args[1] === "d1" && args[2] === "execute") {
	const database = args[3];
	const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
	const sql = flag("--command") ?? readFileSync(flag("--file"), "utf8");
	log({ d1: database, env: flag("--env"), remote: args.includes("--remote"), file: flag("--file") !== null, sql });
	const db = new DatabaseSync(join(process.env.FAKE_DBS, database + ".sqlite"));
	try {
		if (args.includes("--json")) console.log(JSON.stringify([{ results: db.prepare(sql).all(), success: true }]));
		else db.exec(sql);
	} catch (error) {
		console.error("D1_ERROR: " + error.message);
		process.exit(1);
	}
	process.exit(0);
}
console.error("unexpected call", args);
process.exit(2);
`;

// What `npm run render:public` is: the public pages rendered from the build, logged here.
const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "render:public") { appendFileSync(process.env.FAKE_LOG, JSON.stringify({ render: true }) + "\\n"); process.exit(0); }
if (args[0] === "run" && args[1] === "bundle:app") { process.exit(0); }
if (args[0] === "run" && args[1] === "perf:budget") { appendFileSync(process.env.FAKE_LOG, JSON.stringify({ budget: args.slice(2) }) + "\\n"); process.exit(0); }
if (args[0] === "run" && args[1] === "build:api") { appendFileSync(process.env.FAKE_LOG, JSON.stringify({ buildApi: true }) + "\\n"); process.exit(0); }
if (args[0] === "run" && args[1] === "build:readers") { appendFileSync(process.env.FAKE_LOG, JSON.stringify({ buildReaders: true }) + "\\n"); process.exit(0); }
console.error("unexpected npm call", args);
process.exit(2);
`;

// The domain's /__router/health as it is before the cutover (the app answers, with no router header) and after it.
// The deploys of a full run, in order: US app, US public pages, US router, then the EU's. Before the cutover the routers are the
// staged ones (no domain); after it, the ones that hold it.
const DEPLOYS_BOTH = [
	[],
	["--config", "workers/api/wrangler.jsonc"],
	["--config", "workers/readers/wrangler.jsonc"],
	["--config", "workers/public/wrangler.jsonc"],
	["--config", "workers/router/wrangler.jsonc"],
	["--env", "eu"],
	["--config", "workers/api/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/readers/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/public/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/router/wrangler.jsonc", "--env", "eu-staged"],
];
const DEPLOYS_CUT_OVER = [
	[],
	["--config", "workers/api/wrangler.jsonc"],
	["--config", "workers/readers/wrangler.jsonc"],
	["--config", "workers/public/wrangler.jsonc"],
	["--config", "workers/router/wrangler.jsonc", "--env", "us"],
	["--env", "eu"],
	["--config", "workers/api/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/readers/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/public/wrangler.jsonc", "--env", "eu"],
	["--config", "workers/router/wrangler.jsonc", "--env", "eu"],
];

// wrangler.jsonc as it is until the cutover (the app lists both domains) and after it (only a newsletter's own).
const HOLDS_FLOCKSTACK = { routes: [{ pattern: "flockstack.io", custom_domain: true }, { pattern: "newsletter.ankur.works", custom_domain: true }], env: { eu: { routes: [{ pattern: "eu.flockstack.io", custom_domain: true }] } } };
const RELEASED = { routes: [{ pattern: "newsletter.ankur.works", custom_domain: true }], env: { eu: {} } };

const unrouted = async () => new Response("not found", { status: 404 });
const routed = async () => new Response("ok\n", { status: 200, headers: { "x-served-by": "router" } });

let folder;
let migrations;
let previous;

function writeMigrations(files) {
	rmSync(migrations, { recursive: true, force: true });
	mkdirSync(migrations);
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(migrations, name), sql);
}

function readLog() {
	return readFileSync(join(folder, "calls.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function openDb(name) {
	return new DatabaseSync(join(folder, "dbs", `${name}.sqlite`));
}

function tablesOf(name) {
	const db = openDb(name);
	try {
		return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name: table }) => table);
	} finally {
		db.close();
	}
}

function recordedIn(name) {
	const db = openDb(name);
	try {
		return db.prepare("SELECT name FROM _flockstack_migrations ORDER BY name").all().map(({ name: file }) => file);
	} finally {
		db.close();
	}
}

// The check of MCP sign-in (scripts/check-mcp-auth.mjs) after each router, answering from here: it asks the region's address, which a test must not.
const checked = [];
const passing = async ({ baseUrl, apiKey }) => {
	checked.push({ baseUrl, apiKey });
	return [{ name: "a check", ok: true, detail: null }];
};

async function run(argv, { legalTodos = [], fetchImpl = unrouted, config = HOLDS_FLOCKSTACK, checkMcp = passing, optional = "" } = {}) {
	const lines = [];
	const log = console.log;
	console.log = (...parts) => lines.push(parts.join(" "));
	try {
		await main(argv, { migrationsDir: migrations, legalTodos, fetchImpl, wranglerConfig: config, checkMcp, checkPauseMs: 0, optionalWorkers: parseOptionalWorkers(optional) });
	} finally {
		console.log = log;
	}
	return lines.join("\n");
}

before(() => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-deploy-test-"));
	migrations = join(folder, "migrations");
	mkdirSync(join(folder, "bin"));
	mkdirSync(join(folder, "dbs"));
	writeFileSync(join(folder, "bin", "npx"), FAKE_NPX);
	chmodSync(join(folder, "bin", "npx"), 0o755);
	writeFileSync(join(folder, "bin", "npm"), FAKE_NPM);
	chmodSync(join(folder, "bin", "npm"), 0o755);
	previous = { PATH: process.env.PATH, FAKE_LOG: process.env.FAKE_LOG, FAKE_DBS: process.env.FAKE_DBS };
	process.env.PATH = `${join(folder, "bin")}:${process.env.PATH}`;
	process.env.FAKE_LOG = join(folder, "calls.log");
	process.env.FAKE_DBS = join(folder, "dbs");
});

after(() => {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
	checked.length = 0;
	writeFileSync(join(folder, "calls.log"), "");
	for (const file of readdirSync(join(folder, "dbs"))) rmSync(join(folder, "dbs", file));
	writeMigrations({
		"0001_init.sql": "CREATE TABLE one (id TEXT);\n",
		"0002_more.sql": "CREATE TABLE two (id TEXT);\n",
		"0003_next.sql": "-- a comment first\nCREATE TABLE three (id TEXT);\nCREATE INDEX i_three ON three (id);\n",
	});
});

describe("the pieces", () => {
	test("--only, --dry-run, --skip-build and --baseline, and nothing else", () => {
		assert.deepEqual(parseArgs([]), { only: null, isDryRun: false, skipBuild: false, skipRouterCheck: false, baseline: 6 });
		assert.deepEqual(parseArgs(["--only", "eu", "--dry-run", "--skip-build", "--baseline", "0004"]), { only: "eu", isDryRun: true, skipBuild: true, skipRouterCheck: false, baseline: 4 });
		assert.equal(parseArgs(["--skip-router-check"]).skipRouterCheck, true);
		assert.throws(() => parseArgs(["--allow-legal-todos"]), /Unknown option --allow-legal-todos/);
		assert.throws(() => parseArgs(["--only", "asia"]), /--only takes us or eu/);
		assert.throws(() => parseArgs(["--only"]), /--only takes us or eu/);
		assert.throws(() => parseArgs(["--baseline", "soon"]), /--baseline takes a migration number/);
		assert.throws(() => parseArgs(["--force"]), /Unknown option --force/);
	});

	test("the API Workers of each region are the ones in workers/api, and the routers bind them", () => {
		const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		const apiConfig = read("workers/api/wrangler.jsonc");
		const routerConfig = read("workers/router/wrangler.jsonc");
		assert.equal(apiConfig.build.command, "npm run build:api", "Wrangler builds it wherever it is run from");
		assert.equal(apiConfig.env.eu.build.command, "npm run build:api");
		assert.equal(REGIONS.us.apiWorker, apiConfig.name);
		assert.deepEqual(REGIONS.us.apiArgs, ["--config", "workers/api/wrangler.jsonc"]);
		assert.equal(REGIONS.eu.apiWorker, apiConfig.env.eu.name);
		assert.deepEqual(REGIONS.eu.apiArgs, ["--config", "workers/api/wrangler.jsonc", "--env", "eu"]);
		const bound = (config) => config.services.find(({ binding }) => binding === "API").service;
		assert.equal(bound(routerConfig), REGIONS.us.apiWorker);
		assert.equal(bound(routerConfig.env.us), REGIONS.us.apiWorker);
		assert.equal(bound(routerConfig.env["eu-staged"]), REGIONS.eu.apiWorker);
		assert.equal(bound(routerConfig.env.eu), REGIONS.eu.apiWorker);
		// The API Worker is bound to its region's own database and app, and nothing reaches it from outside.
		const appConfig = read("wrangler.jsonc");
		assert.deepEqual(apiConfig.d1_databases[0].database_id, appConfig.d1_databases[0].database_id);
		assert.deepEqual(apiConfig.env.eu.d1_databases[0].database_id, appConfig.env.eu.d1_databases[0].database_id);
		assert.equal(apiConfig.services.find(({ binding }) => binding === "APP").service, appConfig.name);
		assert.equal(apiConfig.env.eu.services.find(({ binding }) => binding === "APP").service, appConfig.env.eu.name);
		for (const config of [apiConfig, apiConfig.env.eu]) {
			assert.equal(config.workers_dev, false);
			assert.equal(config.routes, undefined);
			assert.equal(config.triggers, undefined, "no crons: the app's");
		}
		assert.deepEqual(apiConfig.r2_buckets, appConfig.r2_buckets);
		assert.deepEqual(apiConfig.env.eu.r2_buckets, appConfig.env.eu.r2_buckets);
		assert.equal(apiConfig.vars.FLOCKSTACK_REGION, "us");
		assert.equal(apiConfig.env.eu.vars.FLOCKSTACK_REGION, "eu");
		assert.equal(apiConfig.env.eu.vars.SES_REGION, appConfig.env.eu.vars.SES_REGION);
	});

	test("the readers Workers of each region are the ones in workers/readers, bound to their region's database and app, and the routers bind them", () => {
		const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		const appConfig = read("wrangler.jsonc");
		const readersConfig = read("workers/readers/wrangler.jsonc");
		const routerConfig = read("workers/router/wrangler.jsonc");
		assert.equal(readersConfig.build.command, "npm run build:readers");
		assert.equal(readersConfig.env.eu.build.command, "npm run build:readers");
		assert.equal(REGIONS.us.readersWorker, readersConfig.name);
		assert.deepEqual(REGIONS.us.readersArgs, ["--config", "workers/readers/wrangler.jsonc"]);
		assert.equal(REGIONS.eu.readersWorker, readersConfig.env.eu.name);
		assert.deepEqual(REGIONS.eu.readersArgs, ["--config", "workers/readers/wrangler.jsonc", "--env", "eu"]);
		const bound = (config) => config.services.find(({ binding }) => binding === "READERS").service;
		assert.equal(bound(routerConfig), REGIONS.us.readersWorker);
		assert.equal(bound(routerConfig.env.us), REGIONS.us.readersWorker);
		assert.equal(bound(routerConfig.env["eu-staged"]), REGIONS.eu.readersWorker);
		assert.equal(bound(routerConfig.env.eu), REGIONS.eu.readersWorker);
		assert.deepEqual(readersConfig.d1_databases[0].database_id, appConfig.d1_databases[0].database_id);
		assert.deepEqual(readersConfig.env.eu.d1_databases[0].database_id, appConfig.env.eu.d1_databases[0].database_id);
		assert.equal(readersConfig.services.find(({ binding }) => binding === "APP").service, appConfig.name);
		assert.equal(readersConfig.env.eu.services.find(({ binding }) => binding === "APP").service, appConfig.env.eu.name);
		for (const config of [readersConfig, readersConfig.env.eu]) {
			assert.equal(config.workers_dev, false, "nothing reaches it from outside");
			assert.equal(config.routes, undefined);
			assert.equal(config.r2_buckets, undefined, "none of these endpoints stores a file");
			assert.equal(config.no_bundle, true);
		}
		assert.equal(readersConfig.vars.FLOCKSTACK_REGION, "us");
		assert.equal(readersConfig.env.eu.vars.FLOCKSTACK_REGION, "eu");
		assert.equal(readersConfig.env.eu.vars.SES_REGION, appConfig.env.eu.vars.SES_REGION);
	});

	test("the public pages and router Workers of each region are the ones in workers/public and workers/router", () => {
		const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		const publicConfig = read("workers/public/wrangler.jsonc");
		const routerConfig = read("workers/router/wrangler.jsonc");
		assert.equal(REGIONS.us.publicWorker, publicConfig.name);
		assert.deepEqual(REGIONS.us.publicArgs, ["--config", "workers/public/wrangler.jsonc"]);
		assert.equal(REGIONS.eu.publicWorker, publicConfig.env.eu.name);
		assert.deepEqual(REGIONS.eu.publicArgs, ["--config", "workers/public/wrangler.jsonc", "--env", "eu"]);
		assert.equal(REGIONS.us.routerWorker, routerConfig.env.us.name);
		assert.deepEqual(REGIONS.us.routerArgs, ["--config", "workers/router/wrangler.jsonc", "--env", "us"]);
		assert.deepEqual(REGIONS.us.routerStagedArgs, ["--config", "workers/router/wrangler.jsonc"]);
		assert.equal(routerConfig.routes, undefined, "the staged US router has no domain");
		assert.deepEqual(REGIONS.eu.routerStagedArgs, ["--config", "workers/router/wrangler.jsonc", "--env", "eu-staged"]);
		assert.equal(routerConfig.env["eu-staged"].routes, undefined, "nor has the staged EU one");
		assert.equal(REGIONS.eu.routerWorker, routerConfig.env.eu.name);
		assert.deepEqual(REGIONS.eu.routerArgs, ["--config", "workers/router/wrangler.jsonc", "--env", "eu"]);
		// The router deployed with routes is the cutover, so it is the environment that carries the domain.
		assert.ok(routerConfig.env.us.routes[0].custom_domain && routerConfig.env.eu.routes[0].custom_domain);
	});

	test("the regions are the ones in wrangler.jsonc: the top level is the US, env.eu the EU", () => {
		const config = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		assert.equal(REGIONS.us.worker, config.name);
		assert.equal(REGIONS.us.database, config.d1_databases[0].database_name);
		assert.deepEqual(REGIONS.us.wranglerArgs, []);
		assert.equal(REGIONS.eu.worker, config.env.eu.name);
		assert.equal(REGIONS.eu.database, config.env.eu.d1_databases[0].database_name);
		assert.deepEqual(REGIONS.eu.wranglerArgs, ["--env", "eu"]);
		assert.equal(config.vars.FLOCKSTACK_REGION, "us");
		assert.equal(config.env.eu.vars.FLOCKSTACK_REGION, "eu");
		assert.ok(config.env.eu.r2_buckets.every((bucket) => bucket.jurisdiction === "eu"));
		assert.equal(config.env.eu.d1_databases[0].binding, config.d1_databases[0].binding);
		assert.deepEqual(
			config.env.eu.r2_buckets.map(({ binding }) => binding),
			config.r2_buckets.map(({ binding }) => binding)
		);
	});

	test("the migrations in the repository are numbered in order and each ends with a semicolon, so a record can follow it", () => {
		const files = listMigrations();
		assert.ok(files.length >= 6);
		// A number can be held by a branch that hasn't merged yet, so numbers go up without repeating; none is skipped once all are in.
		const numbers = files.map((name) => Number(name.slice(0, 4)));
		numbers.forEach((number, index) => assert.ok(Number.isInteger(number) && number > (numbers[index - 1] ?? 0), files[index]));
		for (const name of files) assert.doesNotThrow(() => buildMigrationSql(name, readFileSync(join(ROOT, "migrations", name), "utf8")), name);
	});

	test("what a database is taken to have, and what is left", () => {
		const files = ["0001_a.sql", "0002_b.sql", "0003_c.sql"];
		assert.deepEqual(getBaselineFiles(files, 2), ["0001_a.sql", "0002_b.sql"]);
		assert.deepEqual(getBaselineFiles(files, 0), []);
		assert.deepEqual(getPendingFiles(files, ["0001_a.sql", "0003_c.sql"]), ["0002_b.sql"]);
		assert.deepEqual(getPendingFiles(files, files), []);
	});

	test("a migration and its record travel in one command, and a file without a final semicolon is refused", () => {
		const sql = buildMigrationSql("0007_x.sql", "CREATE TABLE x (id TEXT);\n", new Date("2026-10-18T10:00:00.000Z"));
		assert.equal(sql, "CREATE TABLE x (id TEXT);\nINSERT OR IGNORE INTO _flockstack_migrations (name, applied_at) VALUES ('0007_x.sql', '2026-10-18T10:00:00.000Z');\n");
		assert.throws(() => buildMigrationSql("0008_y.sql", "CREATE TABLE y (id TEXT)"), /semicolon/);
		assert.match(buildBaselineSql(["0001_a.sql", "0002_b.sql"]), /^CREATE TABLE IF NOT EXISTS _flockstack_migrations .* VALUES \('0001_a\.sql', 'baseline [^']+'\), \('0002_b\.sql'/);
		assert.equal(buildBaselineSql([]), "CREATE TABLE IF NOT EXISTS _flockstack_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);");
	});

	test("Wrangler's JSON answer is read for its rows, banner or not", () => {
		assert.deepEqual(parseRows('[{"results":[{"name":"a"},{"name":"b"}],"success":true}]'), [{ name: "a" }, { name: "b" }]);
		assert.deepEqual(parseRows(' ⛅️ wrangler [info] ready\n[{"results":[],"success":true}]'), []);
		assert.throws(() => parseRows("nothing"), /No JSON/);
	});
});

describe("a run", () => {
	test("builds once, records what was applied by hand without running it, applies the rest, then deploys each region's app, public pages and router", async () => {
		for (const name of ["flockstack", "flockstack-eu"]) {
			const db = openDb(name);
			db.exec("CREATE TABLE one (id TEXT); CREATE TABLE two (id TEXT);");
			db.close();
		}
		await run(["--baseline", "2"]);

		for (const name of ["flockstack", "flockstack-eu"]) {
			assert.deepEqual(tablesOf(name), ["_flockstack_migrations", "one", "three", "two"]);
			assert.deepEqual(recordedIn(name), ["0001_init.sql", "0002_more.sql", "0003_next.sql"]);
		}
		const calls = readLog();
		assert.equal(calls.filter((call) => call.build).length, 1, "one build");
		assert.equal(calls.find((call) => call.build).cloudBuild, "true", "built as the Cloud build, without the S3, CloudFront and Vercel Blob clients");
		assert.equal(calls.filter((call) => call.render).length, 1, "and one rendering of the public pages from it");
		assert.ok(calls.findIndex((call) => call.build) < calls.findIndex((call) => call.render), "the build first");
		assert.ok(calls.findIndex((call) => call.render) < calls.findIndex((call) => call.d1), "then the pages, before anything is changed");
		assert.equal(calls.filter((call) => call.buildApi).length, 1, "and one build of the API Worker, before anything is changed");
		assert.ok(calls.findIndex((call) => call.buildApi) < calls.findIndex((call) => call.d1));
		assert.equal(calls.filter((call) => call.buildReaders).length, 1, "and one build of the readers Worker");
		assert.ok(calls.findIndex((call) => call.buildReaders) < calls.findIndex((call) => call.d1));
		assert.deepEqual(calls.filter((call) => call.deploy).map(({ deploy }) => deploy), DEPLOYS_BOTH, "per region: the app, then the API and readers Workers, then the public pages, then the router");
		assert.equal(calls.findIndex((call) => call.deploy), calls.length - 10, "the deploys come last, after every migration");
		assert.deepEqual(
			[...new Set(calls.filter((call) => call.d1).map(({ d1, env, remote }) => `${d1}:${env}:${remote}`))],
			["flockstack:null:true", "flockstack-eu:eu:true"]
		);
		assert.equal(calls.filter((call) => call.file).length, 2, "only 0003 ran, once on each");
	});

	test("running it again applies nothing", async () => {
		await run(["--baseline", "0"]);
		assert.deepEqual(recordedIn("flockstack-eu"), ["0001_init.sql", "0002_more.sql", "0003_next.sql"]);
		const before = readLog().length;
		await run(["--baseline", "0"]);
		const second = readLog().slice(before);
		assert.equal(second.filter((call) => call.file).length, 0);
		assert.equal(second.filter((call) => call.deploy).length, 10, "it deploys again all the same");
	});

	test("a file added later is the only one that runs", async () => {
		await run(["--baseline", "0"]);
		writeFileSync(join(migrations, "0004_added.sql"), "CREATE TABLE four (id TEXT);\n");
		const before = readLog().length;
		await run(["--skip-build"]);
		const second = readLog().slice(before);
		assert.equal(second.filter((call) => call.build).length, 0);
		assert.equal(second.filter((call) => call.render).length, 0, "no build, nothing to render again");
		assert.deepEqual(second.filter((call) => call.file).map(({ sql }) => /CREATE TABLE (\w+)/.exec(sql)[1]), ["four", "four"]);
		assert.deepEqual(recordedIn("flockstack").at(-1), "0004_added.sql");
		assert.ok(tablesOf("flockstack-eu").includes("four"));
	});

	test("--only eu leaves the US database and Worker alone", async () => {
		await run(["--only", "eu", "--baseline", "0"]);
		const calls = readLog();
		assert.deepEqual(calls.filter((call) => call.deploy).map(({ deploy }) => deploy), DEPLOYS_BOTH.slice(5));
		assert.ok(calls.filter((call) => call.d1).every(({ d1 }) => d1 === "flockstack-eu"));
		assert.deepEqual(readdirSync(join(folder, "dbs")), ["flockstack-eu.sqlite"]);
	});

	test("a migration that fails stops the run before any Worker is deployed, and the next run applies it", async () => {
		writeFileSync(join(migrations, "0004_broken.sql"), "CREATE TABLE four (id TEXT;\n");
		await assert.rejects(run(["--baseline", "0"]), /failed/);
		assert.equal(readLog().filter((call) => call.deploy).length, 0, "no Worker was changed");
		assert.ok(!recordedIn("flockstack").includes("0004_broken.sql"));

		writeFileSync(join(migrations, "0004_broken.sql"), "CREATE TABLE four (id TEXT);\n");
		await run(["--skip-build"]);
		assert.ok(recordedIn("flockstack").includes("0004_broken.sql"));
		assert.equal(readLog().filter((call) => call.deploy).length, 10);
	});

	test("--dry-run prints the commands and runs none", async () => {
		const output = await run(["--dry-run"]);
		assert.deepEqual(readLog(), []);
		assert.deepEqual(readdirSync(join(folder, "dbs")), []);
		assert.match(output, /\$ npx opennextjs-cloudflare build/);
		assert.match(output, /\$ npx wrangler d1 execute flockstack --remote --yes/);
		assert.match(output, /\$ npx wrangler d1 execute flockstack-eu --remote --yes --env eu/);
		assert.match(output, /\$ npm run render:public/);
		assert.match(output, /\$ npm run build:api/);
		assert.match(output, /\$ npm run build:readers/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/readers\/wrangler\.jsonc --env eu\n/);
		assert.match(output, /\$ npm run perf:budget -- --require-app/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/api\/wrangler\.jsonc --env eu\n/);
		assert.match(output, /\$ npx wrangler deploy\n/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/public\/wrangler\.jsonc\n/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/router\/wrangler\.jsonc\n/, "the router without the domain while the app still has it");
		assert.match(output, /\$ npx wrangler deploy --env eu/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/public\/wrangler\.jsonc --env eu\n/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/router\/wrangler\.jsonc --env eu-staged\n/);
		assert.match(output, /Would ask https:\/\/flockstack\.io\/__router\/health for x-served-by: router\./);
		assert.match(output, /Dry run done\./);
	});

	test("placeholders left in lib/legal.js don't stop it: it names them, says the legal pages stay hidden and deploys", async () => {
		const output = await run(["--baseline", "0"], { legalTodos: [["EFFECTIVE_DATE", "TODO: a date"], ["SERVICES_LIVE_CONFIRMED", "TODO: once live"]] });
		assert.match(output, /Legal pages stay hidden until these are filled in lib\/legal\.js: EFFECTIVE_DATE, SERVICES_LIVE_CONFIRMED\./);
		assert.equal(readLog().filter((call) => call.deploy).length, 10);
		assert.match(output, /Deployed flockstack, flockstack-api, flockstack-readers, flockstack-public, flockstack-router, flockstack-eu, flockstack-api-eu, flockstack-readers-eu, flockstack-public-eu, flockstack-router-eu\./);
		writeFileSync(join(folder, "calls.log"), "");
		assert.doesNotMatch(await run(["--skip-build"]), /Legal pages/);
	});

	test("by default it reads lib/legal.js itself", async () => {
		const { getLegalTodos } = await import("../lib/legal.js");
		const lines = [];
		const log = console.log;
		console.log = (...parts) => lines.push(parts.join(" "));
		try {
			await main(["--dry-run"], { migrationsDir: migrations });
		} finally {
			console.log = log;
		}
		const todos = getLegalTodos();
		if (todos.length > 0) assert.ok(lines.join("\n").includes(todos.map(([name]) => name).join(", ")));
		else assert.doesNotMatch(lines.join("\n"), /Legal pages/);
	});
});

describe("the domain and the Worker that holds it", () => {
	const holdsFlockstack = HOLDS_FLOCKSTACK;
	const released = RELEASED;

	test("reads from wrangler.jsonc whether the app lists a region's domain", () => {
		assert.equal(appHoldsDomain("us", holdsFlockstack), true);
		assert.equal(appHoldsDomain("eu", holdsFlockstack), true);
		assert.equal(appHoldsDomain("us", released), false, "newsletter.ankur.works is a newsletter's, not flockstack.io");
		assert.equal(appHoldsDomain("eu", released), false);
		assert.equal(appHoldsDomain("us", {}), false);
		assert.equal(appHoldsDomain("us", { routes: ["flockstack.io"] }), true);
	});

	test("the repository's wrangler.jsonc keeps a newsletter's domain on the app for good", () => {
		const config = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		assert.ok(config.routes.some((route) => route.pattern === "newsletter.ankur.works"));
		assert.equal(typeof appHoldsDomain("us", config), "boolean");
		assert.equal(typeof appHoldsDomain("eu", config), "boolean");
	});

	test("asks the domain's health path and takes only the router's answer", async () => {
		assert.equal(await isRouterLive("us", routed), true);
		assert.equal(await isRouterLive("us", unrouted), false);
		assert.equal(await isRouterLive("us", async () => new Response("ok", { status: 200, headers: { "x-served-by": "app" } })), false);
		assert.equal(await isRouterLive("us", async () => new Response("down", { status: 503, headers: { "x-served-by": "router" } })), false);
		assert.equal(await isRouterLive("eu", async () => { throw new Error("no route to host"); }), false);
		const asked = [];
		await isRouterLive("eu", async (url) => (asked.push(url), routed()));
		assert.deepEqual(asked, ["https://eu.flockstack.io/__router/health"]);
	});

	test("stops, before changing anything, when the router already has the domain and wrangler.jsonc still lists it for the app", async () => {
		await assert.rejects(run(["--baseline", "0"], { fetchImpl: routed }), /answered by the router, but wrangler\.jsonc still lists that domain/);
		assert.deepEqual(readLog(), [], "no build, no migration, no deploy");
	});

	test("stops, before changing anything, when wrangler.jsonc has let the domain go and the router does not hold it yet", async () => {
		await assert.rejects(run(["--baseline", "0"], { fetchImpl: unrouted, config: RELEASED }), /not answered by the router, and wrangler\.jsonc no longer lists that domain/);
		assert.deepEqual(readLog(), []);
	});

	test("goes on after the cutover: the router holds the domain and wrangler.jsonc has let it go; --only checks only its region", async () => {
		const output = await run(["--baseline", "0"], { fetchImpl: routed, config: RELEASED });
		assert.match(output, /served by the router, and not a route of the app/);
		assert.deepEqual(readLog().filter((call) => call.deploy).map(({ deploy }) => deploy), DEPLOYS_CUT_OVER, "now the routers that hold the domains");
		const asked = [];
		await run(["--only", "eu", "--baseline", "0"], { fetchImpl: async (url) => (asked.push(url), routed()), config: RELEASED });
		assert.deepEqual(asked, ["https://eu.flockstack.io/__router/health"]);
	});

	test("one region cut over and the other not: --only us is checked on the US alone", async () => {
		const usOnly = { routes: [{ pattern: "newsletter.ankur.works", custom_domain: true }], env: { eu: { routes: [{ pattern: "eu.flockstack.io", custom_domain: true }] } } };
		const answers = async (url) => (url.startsWith("https://flockstack.io") ? routed() : unrouted());
		await run(["--only", "us", "--baseline", "0"], { fetchImpl: answers, config: usOnly });
		await run(["--only", "eu", "--baseline", "0"], { fetchImpl: answers, config: usOnly });
		await assert.rejects(run(["--baseline", "0"], { fetchImpl: routed, config: usOnly }), /eu\.flockstack\.io.*answered by the router, but wrangler\.jsonc still lists/);
	});

	test("goes on with --skip-router-check, and says it skipped", async () => {
		const output = await run(["--baseline", "0", "--skip-router-check"], { fetchImpl: routed });
		assert.match(output, /Skipped \(--skip-router-check\)/);
		assert.equal(readLog().filter((call) => call.deploy).length, 10);
	});

	test("goes on when the domain is still the app's own, which is how it is until the cutover", async () => {
		const output = await run(["--baseline", "0"], { fetchImpl: unrouted });
		assert.match(output, /still the app's own route \(no router yet\)/);
	});
});

describe("the check that MCP clients can still sign in, after each region's router", () => {
	test("runs against each region's address after its router, and says it passed", async () => {
		const output = await run(["--baseline", "0"]);
		assert.deepEqual(checked.map(({ baseUrl }) => baseUrl), ["https://flockstack.io", "https://eu.flockstack.io"]);
		assert.match(output, /==> Check sign-in for MCP clients: https:\/\/flockstack\.io\n[\s\S]*OK \(set FLOCKSTACK_API_KEY/);
		const order = output.split("\n").filter((line) => /^==> (Deploy: flockstack-router|Check sign-in)/.test(line));
		assert.deepEqual(order.map((line) => line.replace(/ \(.*$/, "")), [
			"==> Deploy: flockstack-router",
			"==> Check sign-in for MCP clients: https://flockstack.io",
			"==> Deploy: flockstack-router-eu",
			"==> Check sign-in for MCP clients: https://eu.flockstack.io",
		]);
	});

	test("a failing check is a warning, asked a second time, and the deploy goes on and finishes", async () => {
		let asked = 0;
		const failing = async () => {
			asked++;
			return [{ name: "signing keys", ok: false, detail: "answered 502 instead of 200" }];
		};
		const warnings = [];
		const warn = console.warn;
		console.warn = (...parts) => warnings.push(parts.join(" "));
		let output;
		try {
			output = await run(["--baseline", "0"], { checkMcp: failing });
		} finally {
			console.warn = warn;
		}
		assert.equal(asked, 4, "twice for each of the two regions");
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /WARNING: 1 of 1 checks of https:\/\/flockstack\.io failed.*node scripts\/check-mcp-auth\.mjs https:\/\/flockstack\.io/);
		assert.match(output, /FAIL {2}signing keys\n\s+answered 502 instead of 200/);
		assert.match(output, /Deployed flockstack, /);
		assert.equal(readLog().filter((call) => call.deploy).length, 10, "every Worker was deployed");
	});

	test("a check that throws is a warning too", async () => {
		const warnings = [];
		const warn = console.warn;
		console.warn = (...parts) => warnings.push(parts.join(" "));
		try {
			await run(["--baseline", "0", "--only", "us"], { checkMcp: async () => { throw new Error("offline"); } });
		} finally {
			console.warn = warn;
		}
		assert.deepEqual(warnings, ["WARNING: could not check https://flockstack.io: offline"]);
	});

	test("uses FLOCKSTACK_API_KEY only for the region the key belongs to", async () => {
		const original = process.env.FLOCKSTACK_API_KEY;
		process.env.FLOCKSTACK_API_KEY = `mc_eu_${"A".repeat(43)}`;
		try {
			await run(["--baseline", "0"]);
		} finally {
			if (original === undefined) delete process.env.FLOCKSTACK_API_KEY;
			else process.env.FLOCKSTACK_API_KEY = original;
		}
		assert.deepEqual(checked.map(({ baseUrl, apiKey }) => [baseUrl, Boolean(apiKey)]), [["https://flockstack.io", false], ["https://eu.flockstack.io", true]]);
	});

	test("a dry run says what it would check and asks nothing", async () => {
		const output = await run(["--dry-run", "--skip-router-check"]);
		assert.match(output, /Would run: node scripts\/check-mcp-auth\.mjs https:\/\/flockstack\.io\n/);
		assert.match(output, /Would run: node scripts\/check-mcp-auth\.mjs https:\/\/eu\.flockstack\.io\n/);
		assert.equal(checked.length, 0);
	});
});

describe("optional Workers", () => {
	const COPIES = ["wrangler.optional.jsonc", "workers/api/wrangler.optional.jsonc", "workers/router/wrangler.optional.jsonc", "workers/collaboration/wrangler.optional.jsonc"];
	const deploys = () => readLog().filter((call) => call.deploy);
	const bindingsOf = (config) => (config.services ?? []).filter(({ binding }) => binding.startsWith("COLLABORATION_")).map(({ binding }) => binding);
	const leftover = () => COPIES.filter((path) => existsSync(join(ROOT, path)));

	test("without a setting nothing optional is deployed or bound, and the plain commands are the ones that run", async () => {
		const output = await run(["--baseline", "0"]);
		assert.deepEqual(deploys().map(({ deploy }) => deploy), DEPLOYS_BOTH);
		assert.ok(deploys().every(({ config }) => config === null));
		assert.match(output, /==> Optional Workers\n    us: none[^\n]*\n    eu: none/);
		assert.deepEqual(leftover(), []);
	});

	test("a provisioned collaboration Worker is deployed first, with its flag off, and the app, API Worker and router get its bindings for that deploy only", async () => {
		const output = await run(["--baseline", "0", "--only", "us"], { optional: '{"us":{"collaboration":"provisioned"}}' });
		const calls = deploys();
		assert.deepEqual(calls.map(({ deploy }) => deploy), [
			["--config", "workers/collaboration/wrangler.jsonc"],
			["--config", "wrangler.optional.jsonc"],
			["--config", "workers/api/wrangler.optional.jsonc"],
			["--config", "workers/readers/wrangler.jsonc"],
			["--config", "workers/public/wrangler.jsonc"],
			["--config", "workers/router/wrangler.optional.jsonc"],
		]);
		assert.deepEqual(bindingsOf(calls[1].config), ["COLLABORATION_SOCKET", "COLLABORATION_STORAGE"]);
		assert.ok(calls[1].config.services.some(({ binding }) => binding === "WEBSITE"), "the copy keeps what the file had");
		assert.equal(calls[1].config.main, ".worker/worker-entry.js", "and its relative paths, which hold because the copy sits beside the original");
		assert.deepEqual(bindingsOf(calls[2].config), ["COLLABORATION_STORAGE"]);
		assert.deepEqual(bindingsOf(calls[5].config), ["COLLABORATION_SOCKET"]);
		assert.ok(calls.every(({ config }) => !config || !JSON.stringify(config).includes("COLLABORATION_ENABLED")), "the flag is not a variable of the app, API Worker or router");
		assert.match(output, /==> Optional Workers\n    us: collaboration provisioned\./);
		assert.match(output, /\+ top level: COLLABORATION_SOCKET -> flockstack-collaboration \(flockstack, this deploy only\)/);
		assert.match(output, /Deployed flockstack, flockstack-api, flockstack-readers, flockstack-public, flockstack-router, flockstack-collaboration\./);
		assert.deepEqual(leftover(), [], "the copies are gone");
	});

	test("an enabled collaboration Worker keeps its flag on at every deploy, with the test origins when there are some", async () => {
		await run(["--baseline", "0", "--only", "eu"], { optional: '{"eu":{"collaboration":{"state":"enabled","testOrigins":["https://flockstack-router-eu.example.workers.dev"]}}}' });
		const calls = deploys();
		assert.deepEqual(calls[0].deploy, ["--config", "workers/collaboration/wrangler.jsonc", "--env", "eu", "--var", "COLLABORATION_ENABLED:true", "--var", "COLLABORATION_ALLOWED_ORIGINS:https://flockstack-router-eu.example.workers.dev"]);
		assert.deepEqual(calls[1].deploy, ["--config", "wrangler.optional.jsonc", "--env", "eu"]);
		assert.deepEqual(calls[2].deploy, ["--config", "workers/api/wrangler.optional.jsonc", "--env", "eu"]);
		assert.deepEqual(calls[5].deploy, ["--config", "workers/router/wrangler.optional.jsonc", "--env", "eu-staged"], "the staged router while the app holds the domain");
		assert.deepEqual(bindingsOf(calls[1].config.env.eu), ["COLLABORATION_SOCKET", "COLLABORATION_STORAGE"]);
		assert.equal(calls[1].config.env.eu.services.find(({ binding }) => binding === "COLLABORATION_SOCKET").service, "flockstack-collaboration-eu");
		assert.deepEqual(bindingsOf(calls[1].config), [], "nothing for the US part of the same file");
	});

	test("the router that holds the domain gets the binding too, and a region without the Worker is deployed as it always was", async () => {
		await run(["--baseline", "0"], { optional: '{"us":{"collaboration":"provisioned"}}', config: RELEASED, fetchImpl: routed });
		const commands = deploys().map(({ deploy }) => deploy);
		assert.deepEqual(commands[5], ["--config", "workers/router/wrangler.optional.jsonc", "--env", "us"]);
		assert.deepEqual(commands.slice(6), DEPLOYS_CUT_OVER.slice(5), "the EU is the plain commands");
	});

	test("a replies Worker is deployed last in its region and needs no binding anywhere", async () => {
		await run(["--baseline", "0"], { optional: '{"us":{"replies":true},"eu":{"replies":true}}' });
		assert.deepEqual(deploys().map(({ deploy }) => deploy), [
			...DEPLOYS_BOTH.slice(0, 5),
			["--config", "workers/replies/wrangler.jsonc"],
			...DEPLOYS_BOTH.slice(5),
			["--config", "workers/replies/wrangler.jsonc", "--env", "eu"],
		]);
		assert.ok(deploys().every(({ config }) => config === null));
	});

	test("--only leaves the other region's optional Workers alone", async () => {
		await run(["--baseline", "0", "--only", "us"], { optional: '{"eu":{"collaboration":"enabled","replies":true}}' });
		assert.deepEqual(deploys().map(({ deploy }) => deploy), DEPLOYS_BOTH.slice(0, 5));
	});

	test("a dry run shows the copies it would use and what they add, and writes nothing", async () => {
		const output = await run(["--dry-run", "--only", "us"], { optional: '{"us":{"collaboration":"enabled","replies":true}}' });
		assert.deepEqual(readLog(), []);
		assert.deepEqual(leftover(), []);
		assert.match(output, /\$ npx wrangler deploy --config workers\/collaboration\/wrangler\.jsonc --var COLLABORATION_ENABLED:true\n/);
		assert.match(output, /\$ npx wrangler deploy --config wrangler\.optional\.jsonc\n/);
		assert.match(output, /\+ top level: COLLABORATION_STORAGE -> flockstack-collaboration#CollaborationStorage \(flockstack-api, this deploy only\)/);
		assert.match(output, /\$ npx wrangler deploy --config workers\/replies\/wrangler\.jsonc\n/);
	});

	test("a deploy that fails still removes the copy", async () => {
		process.env.FAKE_FAIL_DEPLOY = "workers/api/wrangler.optional.jsonc";
		try {
			await assert.rejects(run(["--baseline", "0", "--only", "us"], { optional: '{"us":{"collaboration":"provisioned"}}' }), /npx wrangler failed with exit code 1/);
		} finally {
			delete process.env.FAKE_FAIL_DEPLOY;
		}
		assert.deepEqual(leftover(), []);
	});

	test("a setting it cannot read stops the run before anything is built, migrated or deployed", async () => {
		const original = process.env.FLOCKSTACK_OPTIONAL_WORKERS;
		process.env.FLOCKSTACK_OPTIONAL_WORKERS = '{"us":{"collaboration":"yes"}}';
		try {
			await assert.rejects(main(["--baseline", "0"], { migrationsDir: migrations, legalTodos: [], fetchImpl: unrouted, wranglerConfig: HOLDS_FLOCKSTACK, checkMcp: passing, checkPauseMs: 0 }), /collaboration for us is/);
		} finally {
			if (original === undefined) delete process.env.FLOCKSTACK_OPTIONAL_WORKERS;
			else process.env.FLOCKSTACK_OPTIONAL_WORKERS = original;
		}
		assert.deepEqual(readLog(), []);
	});
});
