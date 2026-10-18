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
			return shape(await prepare({ sql, params }).all());
		},
		async batch(statements) {
			if (statements.length === 0) return [];
			return (await binding.batch(statements.map(prepare))).map(shape);
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
		const result = statement.run(...params);
		return { rows: [], changes: Number(result.changes) };
	}
	return {
		kind: "sqlite",
		managedSchema: false,
		async query(sql, params = []) {
			return run(sql, params);
		},
		async batch(statements) {
			if (statements.length === 0) return [];
			db.exec("BEGIN");
			try {
				const results = statements.map(({ sql, params }) => run(sql, params));
				db.exec("COMMIT");
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
	return d1Driver(env.DB);
}
