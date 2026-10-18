import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// D1 only has the tables and indexes its migrations made, so a model or an index without one in migrations/ breaks
// production while every test passes on SQLite, which makes them on first use.
const ROOT = new URL("../", import.meta.url);

test("every table and index the models declare is in a migration", async () => {
	const { models } = await import("../lib/docdb/model.js");
	const { schemaStatements } = await import("../lib/docdb/sql.js");
	for (const file of (await readdir(new URL("models/", ROOT))).filter((name) => name.endsWith(".js"))) {
		await import(pathToFileURL(new URL(`models/${file}`, ROOT).pathname).href);
	}
	const written = new Set();
	for (const file of (await readdir(new URL("migrations/", ROOT))).filter((name) => name.endsWith(".sql"))) {
		for (const line of (await readFile(new URL(`migrations/${file}`, ROOT), "utf8")).split("\n")) if (line.trim()) written.add(line.trim().replace(/;$/, ""));
	}
	const missing = Object.values(models).flatMap((model) => schemaStatements(model.collection.collectionName, model.schema)).filter((statement) => !written.has(statement));
	assert.deepEqual(missing, [], "run node scripts/docdb-schema.mjs and add what's missing to a new migration");
});
