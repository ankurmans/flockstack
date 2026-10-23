// Where the documents live: Cloudflare D1 in production, a local SQLite file (or memory) in development and tests.
// Both answer the same two calls, so the rest of lib/docdb never knows which one it has.
//
//   query(sql, params)  -> { rows, changes }
//   batch([{ sql, params }]) -> [{ rows, changes }]   all in one transaction

let driver = null;
let driverPromise = null;

// FLOCKSTACK_DOCDB_TRACE=1 prints the slow statements and a summary on exit: for finding what a page spends on the database.
function traced(inner) {
	const stats = { count: 0, ms: 0, slow: [] };
	const time = async (sql, run) => {
		const start = performance.now();
		if (process.env.FLOCKSTACK_DOCDB_TRACE === "2") console.error(`[docdb] ${sql.slice(0, 200)}`);
		try {
			return await run();
		} finally {
			const took = performance.now() - start;
			stats.count++;
			stats.ms += took;
			if (took > 25) stats.slow.push(`${took.toFixed(0)}ms ${sql.slice(0, 160)}`);
		}
	};
	process.on("exit", () => console.error(`[docdb] ${stats.count} statements, ${stats.ms.toFixed(0)}ms\n${stats.slow.slice(0, 15).join("\n")}`));
	return {
		...inner,
		query: (sql, params) => time(sql, () => inner.query(sql, params)),
		batch: (statements) => time(`BATCH(${statements.length}) ${statements[0]?.sql ?? ""}`, () => inner.batch(statements)),
	};
}

// A test's eyes on the database: setQueryObserver(fn) calls fn({ sql, params, kind, statements, rows }) for every call the driver answers,
// "query" for one statement and "batch" for several in one round trip (list: those statements; rows: the rows the call read, which D1 counts as
// rows_read). tests/query-budget.test.mjs counts what a page asks of the database with it. Nothing is recorded without one.
let observer = null;

export function setQueryObserver(next) {
	observer = typeof next === "function" ? next : null;
}

// FLOCKSTACK_SQL_LOG=<file>: every distinct statement the process runs, with the parameters of its first call, one JSON line each,
// for scripts/explain-queries.mjs to ask SQLite which of them read a whole table. Development and tests only.
if (typeof process !== "undefined" && process.env?.FLOCKSTACK_SQL_LOG) {
	const seen = new Set();
	const logFile = process.env.FLOCKSTACK_SQL_LOG;
	observer = ({ sql, params }) => {
		if (seen.has(sql)) return;
		seen.add(sql);
		import("node:fs").then(({ appendFileSync }) => appendFileSync(logFile, `${JSON.stringify({ sql, params })}\n`));
	};
}

// Reads asked for in the same turn of the event loop go to the database as one batch. A dashboard page asks for twenty things at once
// (Promise.all of counts, lists and lookups), and D1 answers a Worker's parallel calls a few at a time: twenty-two calls took 45 ms
// where one batch of the twenty-two took 13, from a Worker next to its database, and the gap grows with the distance (measured on a
// throwaway database: docs/PERFORMANCE.md). A batch is one round trip, runs its statements in order and answers each one as its
// own call did; a statement that fails is run again on its own, so the caller that sent it, and no other, gets its error.
// Writes and anything but a plain SELECT are sent at once, as before, and so is a read that is alone in its turn.
const MAX_COALESCED = 40;

export function coalescingDriver(inner, { wait = (flush) => setTimeout(flush, 0) } = {}) {
	let waiting = [];
	const isRead = (sql) => /^\s*select\b/i.test(sql) && !/\breturning\b/i.test(sql);

	async function flush() {
		const group = waiting;
		waiting = [];
		for (let start = 0; start < group.length; start += MAX_COALESCED) {
			const slice = group.slice(start, start + MAX_COALESCED);
			if (slice.length === 1) {
				const [only] = slice;
				inner.query(only.sql, only.params).then(only.resolve, only.reject);
				continue;
			}
			inner.batch(slice.map(({ sql, params }) => ({ sql, params }))).then(
				(results) => slice.forEach((item, index) => item.resolve(results[index])),
				// One of them is wrong, or the batch could not run: each is asked again alone, so the errors land where they belong.
				() => slice.forEach((item) => inner.query(item.sql, item.params).then(item.resolve, item.reject))
			);
		}
	}

	return {
		...inner,
		query(sql, params = []) {
			if (!isRead(sql)) return inner.query(sql, params);
			return new Promise((resolve, reject) => {
				if (waiting.length === 0) wait(flush);
				waiting.push({ sql, params, resolve, reject });
			});
		},
	};
}

export function setDriver(next) {
	driver = process.env.FLOCKSTACK_DOCDB_TRACE ? traced(next) : next;
	driverPromise = null;
}

export function hasDriver() {
	return Boolean(driver);
}

export async function getDriver() {
	if (driver) return driver;
	driverPromise ??= createDefaultDriver();
	driver = await driverPromise;
	return driver;
}

export function d1Driver(binding) {
	const prepare = ({ sql, params = [] }) => binding.prepare(sql).bind(...params);
	const shape = (result) => ({ rows: result.results ?? [], changes: result.meta?.changes ?? 0 });
	return {
		kind: "d1",
		managedSchema: true,
		async query(sql, params = []) {
			const result = await prepare({ sql, params }).all();
			observer?.({ sql, params, kind: "query", statements: 1, rows: result.meta?.rows_read ?? result.results?.length ?? 0 });
			return shape(result);
		},
		async batch(statements) {
			if (statements.length === 0) return [];
			const results = await binding.batch(statements.map(prepare));
			observer?.({ sql: statements[0].sql, kind: "batch", statements: statements.length, list: statements, rows: results.reduce((total, result) => total + (result.meta?.rows_read ?? result.results?.length ?? 0), 0) });
			return results.map(shape);
		},
	};
}

// node:sqlite ships with Node 22+. The specifier is built at runtime so bundlers building for Workers leave it alone.
export async function sqliteDriver(path = ":memory:") {
	const moduleName = ["node", "sqlite"].join(":");
	const { DatabaseSync } = await import(/* webpackIgnore: true */ moduleName);
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	function run(sql, params = []) {
		const statement = db.prepare(sql);
		if (/^\s*(select|with|pragma)/i.test(sql)) return { rows: statement.all(...params), changes: 0 };
		if (/\sRETURNING\s/i.test(sql)) {
			const rows = statement.all(...params);
			return { rows, changes: rows.length };
		}
		const result = statement.run(...params);
		return { rows: [], changes: Number(result.changes) };
	}
	return {
		kind: "sqlite",
		managedSchema: false,
		async query(sql, params = []) {
			const result = run(sql, params);
			observer?.({ sql, params, kind: "query", statements: 1, rows: result.rows.length });
			return result;
		},
		async batch(statements) {
			if (statements.length === 0) return [];
			db.exec("BEGIN");
			try {
				const results = statements.map(({ sql, params }) => run(sql, params));
				db.exec("COMMIT");
				observer?.({ sql: statements[0].sql, kind: "batch", statements: statements.length, list: statements, rows: results.reduce((total, result) => total + result.rows.length, 0) });
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close() {
			db.close();
		},
	};
}

async function createDefaultDriver() {
	if (typeof process !== "undefined" && process.env?.FLOCKSTACK_SQLITE) return sqliteDriver(process.env.FLOCKSTACK_SQLITE);
	// On Workers (and in `next dev` with the bindings emulated) the D1 binding comes with the request context.
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	if (!env?.DB) throw new Error("No database: bind a D1 database as DB in wrangler.jsonc, or set FLOCKSTACK_SQLITE to a file path for a local SQLite run");
	return coalescingDriver(d1Driver(env.DB));
}
