import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	REGIONS,
	buildBaselineSql,
	buildMigrationSql,
	getBaselineFiles,
	getPendingFiles,
	listMigrations,
	main,
	parseArgs,
	parseRows,
} from "../scripts/deploy-all.mjs";

// scripts/deploy-all.mjs: one build, the missing migrations on each region's database, then both deploys. The flow runs
// against a stand-in for npx that keeps each D1 database in a SQLite file and writes down every call, so nothing reaches
// Cloudflare.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Stands in for `npx`: wrangler d1 execute against a SQLite file per database, deploys and builds as log lines.
const FAKE_NPX = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
if (args[0] === "opennextjs-cloudflare") { log({ build: true }); process.exit(0); }
if (args[0] === "wrangler" && args[1] === "deploy") { log({ deploy: args.slice(2) }); process.exit(0); }
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

async function run(argv) {
	const lines = [];
	const log = console.log;
	console.log = (...parts) => lines.push(parts.join(" "));
	try {
		main(argv, { migrationsDir: migrations });
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
		assert.deepEqual(parseArgs([]), { only: null, isDryRun: false, skipBuild: false, baseline: 6 });
		assert.deepEqual(parseArgs(["--only", "eu", "--dry-run", "--skip-build", "--baseline", "0004"]), { only: "eu", isDryRun: true, skipBuild: true, baseline: 4 });
		assert.throws(() => parseArgs(["--only", "asia"]), /--only takes us or eu/);
		assert.throws(() => parseArgs(["--only"]), /--only takes us or eu/);
		assert.throws(() => parseArgs(["--baseline", "soon"]), /--baseline takes a migration number/);
		assert.throws(() => parseArgs(["--force"]), /Unknown option --force/);
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
	test("builds once, records what was applied by hand without running it, applies the rest, then deploys both Workers", async () => {
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
		assert.deepEqual(calls.filter((call) => call.deploy).map(({ deploy }) => deploy), [[], ["--env", "eu"]]);
		assert.equal(calls.findIndex((call) => call.deploy), calls.length - 2, "the deploys come last, after every migration");
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
		assert.equal(second.filter((call) => call.deploy).length, 2, "it deploys again all the same");
	});

	test("a file added later is the only one that runs", async () => {
		await run(["--baseline", "0"]);
		writeFileSync(join(migrations, "0004_added.sql"), "CREATE TABLE four (id TEXT);\n");
		const before = readLog().length;
		await run(["--skip-build"]);
		const second = readLog().slice(before);
		assert.equal(second.filter((call) => call.build).length, 0);
		assert.deepEqual(second.filter((call) => call.file).map(({ sql }) => /CREATE TABLE (\w+)/.exec(sql)[1]), ["four", "four"]);
		assert.deepEqual(recordedIn("flockstack").at(-1), "0004_added.sql");
		assert.ok(tablesOf("flockstack-eu").includes("four"));
	});

	test("--only eu leaves the US database and Worker alone", async () => {
		await run(["--only", "eu", "--baseline", "0"]);
		const calls = readLog();
		assert.deepEqual(calls.filter((call) => call.deploy).map(({ deploy }) => deploy), [["--env", "eu"]]);
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
		assert.equal(readLog().filter((call) => call.deploy).length, 2);
	});

	test("--dry-run prints the commands and runs none", async () => {
		const output = await run(["--dry-run"]);
		assert.deepEqual(readLog(), []);
		assert.deepEqual(readdirSync(join(folder, "dbs")), []);
		assert.match(output, /\$ npx opennextjs-cloudflare build/);
		assert.match(output, /\$ npx wrangler d1 execute flockstack --remote --yes/);
		assert.match(output, /\$ npx wrangler d1 execute flockstack-eu --remote --yes --env eu/);
		assert.match(output, /\$ npx wrangler deploy\n/);
		assert.match(output, /\$ npx wrangler deploy --env eu/);
		assert.match(output, /Dry run done\./);
	});
});
