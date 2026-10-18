// Builds FlockStack once, applies the migrations that are missing from each region's database, then deploys the same build
// to each region's Worker: flockstack (US, flockstack.io) and flockstack-eu (EU, eu.flockstack.io). wrangler.jsonc has both.
//   node scripts/deploy-all.mjs [--only us|eu] [--dry-run] [--skip-build] [--baseline 0006]
// --only deploys one region (its database and Worker; the build is still the one build). --dry-run prints every command
// and runs none, and talks to nothing. --skip-build deploys the .open-next folder as it is.
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

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "migrations");
const TRACKER = "_flockstack_migrations";
const DEFAULT_BASELINE = 6;

// Names as in wrangler.jsonc: the top-level config is the US deployment, env.eu the EU one.
export const REGIONS = {
	us: { worker: "flockstack", database: "flockstack", wranglerArgs: [] },
	eu: { worker: "flockstack-eu", database: "flockstack-eu", wranglerArgs: ["--env", "eu"] },
};

export function parseArgs(argv) {
	const options = { only: null, isDryRun: false, skipBuild: false, baseline: DEFAULT_BASELINE };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--dry-run") options.isDryRun = true;
		else if (argument === "--skip-build") options.skipBuild = true;
		else if (argument === "--only") options.only = argv[++index];
		else if (argument === "--baseline") options.baseline = Number.parseInt(argv[++index], 10);
		else throw new Error(`Unknown option ${argument}. Options: --only us|eu, --dry-run, --skip-build, --baseline <number>.`);
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

export function main(argv = process.argv.slice(2), { migrationsDir = MIGRATIONS_DIR } = {}) {
	const options = { ...parseArgs(argv), migrationsDir };
	const regions = options.only ? [options.only] : Object.keys(REGIONS);
	const files = listMigrations(migrationsDir);
	if (options.isDryRun) console.log("Dry run: nothing below is executed.\n");

	console.log("==> Build");
	if (options.skipBuild) console.log("    Skipped (--skip-build): deploying .open-next as it is.");
	else run("npx", ["opennextjs-cloudflare", "build"], options);

	for (const region of regions) migrate(region, files, options);

	for (const region of regions) {
		console.log(`\n==> Deploy: ${REGIONS[region].worker}`);
		run("npx", ["wrangler", "deploy", ...REGIONS[region].wranglerArgs], options);
	}
	console.log(options.isDryRun ? "\nDry run done." : `\nDeployed ${regions.map((region) => REGIONS[region].worker).join(" and ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`\n${error.message}`);
		process.exit(1);
	}
}
