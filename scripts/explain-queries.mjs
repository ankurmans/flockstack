// Asks SQLite which of the statements the app runs read a whole table. Production's database (D1) has the tables and indexes the
// migrations made, so the plans are made on a database built from them.
//   FLOCKSTACK_SQL_LOG=/tmp/sql.jsonl npm test      (writes every distinct statement the tests ran)
//   node scripts/explain-queries.mjs /tmp/sql.jsonl [--all]
// A "SCAN" of a collection's table is a read of every row of it (json_each, the virtual table that unpacks a list parameter, is
// not one). Statements are reported once, in the order of how many rows the table had in the plan's own words. Tests cannot say how
// big a table is in production, so the output is a list to read, not a verdict: a scan of a table that has a few rows for ever is fine.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function openMigrated() {
	const db = new DatabaseSync(":memory:");
	for (const name of readdirSync(`${ROOT}migrations`).filter((file) => file.endsWith(".sql")).sort()) db.exec(readFileSync(`${ROOT}migrations/${name}`, "utf8"));
	return db;
}

function explain(db, sql, params) {
	return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params.map((value) => (typeof value === "boolean" ? Number(value) : value))).map((row) => row.detail);
}

// The plan lines of a statement that read a collection's table whole.
export function findScans(db, sql, params = []) {
	let plan;
	try {
		plan = explain(db, sql, params);
	} catch (error) {
		// A table the migrations do not have is a Better Auth plugin's, which D1 makes on first use (lib/docdb/model.js
		// createMissingTable) with the primary key and the account index only: make it so, and ask again.
		const missing = /no such table: (c_\w+)/.exec(String(error.message))?.[1];
		if (!missing) return { error: String(error.message).slice(0, 80), scans: [] };
		db.exec(`CREATE TABLE IF NOT EXISTS ${missing} (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS i_${missing.slice(2)}__accountId ON ${missing} (accountId);`);
		try {
			plan = explain(db, sql, params);
		} catch (again) {
			return { error: String(again.message).slice(0, 80), scans: [] };
		}
	}
	return { plan, scans: plan.filter((line) => /^SCAN c_/.test(line) && !/USING (COVERING )?INDEX/.test(line)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [file, flag] = process.argv.slice(2);
	if (!file) throw new Error("usage: node scripts/explain-queries.mjs <sql log> [--all]");
	const db = openMigrated();
	const seen = new Set();
	let checked = 0;
	const found = new Map();
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		const { sql, params } = JSON.parse(line);
		if (seen.has(sql) || /^\s*(CREATE|PRAGMA|BEGIN|COMMIT)/i.test(sql)) continue;
		seen.add(sql);
		checked++;
		const { scans, error } = findScans(db, sql, params ?? []);
		if (error && flag === "--all") console.log(`skipped (${error}): ${sql.slice(0, 100)}`);
		for (const scan of scans) found.set(scan, [...(found.get(scan) ?? []), sql]);
	}
	console.log(`${checked} statements checked, ${found.size} tables read whole:\n`);
	for (const [scan, statements] of [...found].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`${scan}  (${statements.length} statements)`);
		for (const sql of statements.slice(0, 3)) console.log(`    ${sql.replace(/\s+/g, " ").slice(0, 190)}`);
	}
}
