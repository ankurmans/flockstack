// Prints the SQL that creates every table and index D1 needs, from the models' schemas.
//   node scripts/docdb-schema.mjs > migrations/0001_init.sql
// Auth tables (Better Auth) are created here too: their unique indexes are the ones the adapter would make on first use.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

register("../tests/setup/hooks.mjs", import.meta.url);

const root = fileURLToPath(new URL("../", import.meta.url));
const { models } = await import("../lib/docdb/model.js");
const { schemaStatements } = await import("../lib/docdb/sql.js");
const { Schema } = await import("../lib/docdb/schema.js");

for (const file of readdirSync(`${root}models`).filter((name) => name.endsWith(".js"))) await import(pathToFileURL(`${root}models/${file}`).href);

const statements = [];
for (const model of Object.values(models)) statements.push(...schemaStatements(model.collection.collectionName, model.schema));

// Better Auth's tables, as lib/accounts.js names them, with the unique keys its schema declares.
const { AUTH_MODELS } = await import("../lib/accounts.js");
const authIndexes = {
	[AUTH_MODELS.user]: [{ email: 1 }],
	[AUTH_MODELS.session]: [{ token: 1 }],
};
for (const name of new Set(Object.values(AUTH_MODELS))) {
	const schema = new Schema({});
	schema.indexes = (authIndexes[name] ?? []).map((fields) => ({ fields, options: { unique: true, plain: true } }));
	statements.push(...schemaStatements(name, schema));
}

console.log(`${statements.map((sql) => `${sql};`).join("\n")}`);
