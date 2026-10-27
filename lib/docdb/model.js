import { getDriver } from "./driver.js";
import { ObjectId, OBJECT_ID_PATTERN } from "./object-id.js";
import {
	applyDefaults,
	looseSchema,
	applyUpdate,
	buildDocument,
	castFilter,
	castUpdate,
	getPath,
	normalizeMixed,
	parseSelect,
	project,
	reviveDates,
	toOutput,
} from "./schema.js";
import { describeIndexes, groupExpression, isScalarPath, orderBy, schemaStatements, sortDocuments, splitFilter, tableName } from "./sql.js";

// mingo (an in-memory evaluator of Mongo's query and pipeline language, narrowed to the operators the app uses: ./mingo-engine.js) is
// loaded where SQL can't answer: a filter the translation to SQL leaves a residual of, an update given as a pipeline, a $lookup's
// sub-pipeline and an aggregation. Most pages never do any of these, and then never load or evaluate it.
let mingo = null;
const loadMingo = () => (mingo ??= import("./mingo-engine.js"));

// The Mongoose subset this app uses, over SQLite rows: Model.find / findOne / updateOne / aggregate... with the same
// filter and update operators, results and errors (code 11000 on a duplicate key).

export const models = {};

const CURSOR_PAGE = 500;
const CAS_RETRIES = 5;
// D1 binds at most 100 parameters to a statement and takes strings up to 2 MB, and every call counts against a Worker's
// limit of queries (a batch is one call: 1,000 documented, 10,000 enforced in scripts/bench-d1's runs). So many rows go in as one JSON array parameter that json_each reads back, in chunks well
// under that size; updateMany and deleteMany read their rows a page at a time, and bulkWrite reads a chunk of upserts
// in one query.
export const BULK_LIMITS = { rowsPerStatement: 1000, paramBytes: 1_000_000, scanPage: 1000, bulkChunk: 500, deleteChunk: 5000 };

function pluralize(name) {
	const lower = name.toLowerCase();
	if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
	if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
	return `${lower}s`;
}

const prepared = new WeakMap();

async function ready(entry) {
	const driver = await getDriver();
	if (driver.managedSchema) return driver;
	let done = prepared.get(driver);
	if (!done) prepared.set(driver, (done = new Set()));
	if (!done.has(entry.collectionName)) {
		await driver.batch(schemaStatements(entry.collectionName, entry.schema).map((sql) => ({ sql, params: [] })));
		done.add(entry.collectionName);
	}
	return driver;
}

function duplicateKeyError(entry, error) {
	const message = String(error?.message ?? error);
	if (!/UNIQUE constraint failed/i.test(message)) return error;
	const named = /index '([^']+)'/.exec(message)?.[1];
	const index = describeIndexes(entry.collectionName, entry.schema).find((item) => item.name === named);
	const keyPattern = index?.fields ?? { _id: 1 };
	const duplicate = new Error(`E11000 duplicate key error collection: ${entry.collectionName} index: ${named ?? "_id_"} dup key`);
	duplicate.name = "MongoServerError";
	duplicate.code = 11000;
	duplicate.keyPattern = keyPattern;
	duplicate.cause = error;
	return duplicate;
}

// D1 comes with the tables its migrations made. A collection the migrations never heard of (one of Better Auth's
// plugins) gets its table the first time something asks for it.
async function createMissingTable(entry, driver, error) {
	if (!/no such table: (main\.)?c_/i.test(String(error?.message ?? error))) return false;
	await driver.batch(schemaStatements(entry.collectionName, entry.schema).map((sql) => ({ sql, params: [] })));
	return true;
}

async function run(entry, driver, sql, params = []) {
	try {
		return await driver.query(sql, params);
	} catch (error) {
		if (await createMissingTable(entry, driver, error)) return run(entry, driver, sql, params);
		throw duplicateKeyError(entry, error);
	}
}

async function runBatch(entry, driver, statements) {
	try {
		return await driver.batch(statements);
	} catch (error) {
		if (await createMissingTable(entry, driver, error)) return runBatch(entry, driver, statements);
		throw duplicateKeyError(entry, error);
	}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Collections without a schema (Better Auth's) get their ISO date strings back as Dates.
function reviveLoose(value) {
	if (typeof value === "string") return ISO_DATE.test(value) ? new Date(value) : value;
	if (Array.isArray(value)) return value.map(reviveLoose);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveLoose(item)]));
	return value;
}

function parseRow(entry, row) {
	const parsed = JSON.parse(row.data);
	return entry.schema.loose ? reviveLoose(parsed) : reviveDates(entry.schema.root, parsed);
}

function insertStatement(entry, doc, { ignore = false } = {}) {
	return {
		sql: `INSERT ${ignore ? "OR IGNORE " : ""}INTO ${tableName(entry.collectionName)} (_id, accountId, data) VALUES (?, ?, ?)`,
		params: [String(doc._id), doc.accountId ?? null, JSON.stringify(doc)],
	};
}

// Rows (arrays of column values) in chunks, each one JSON parameter. A row too big to share a chunk gets one of its own,
// which the callers write with plain parameters.
function packRows(rows) {
	const chunks = [];
	let encoded = [];
	let members = [];
	let bytes = 2;
	const close = () => {
		if (members.length > 0) chunks.push({ rows: members, param: `[${encoded.join(",")}]` });
		encoded = [];
		members = [];
		bytes = 2;
	};
	for (const row of rows) {
		const text = JSON.stringify(row);
		const size = Buffer.byteLength(text) + 1;
		if (members.length >= BULK_LIMITS.rowsPerStatement || (members.length > 0 && bytes + size > BULK_LIMITS.paramBytes)) close();
		encoded.push(text);
		members.push(row);
		bytes += size;
	}
	close();
	return chunks;
}

function insertStatements(entry, documents, { ignore = false } = {}) {
	const table = tableName(entry.collectionName);
	return packRows(documents.map((doc) => [String(doc._id), doc.accountId ?? null, JSON.stringify(doc)])).map(({ rows, param }) =>
		rows.length === 1
			? { sql: `INSERT ${ignore ? "OR IGNORE " : ""}INTO ${table} (_id, accountId, data) VALUES (?, ?, ?)`, params: rows[0] }
			: {
					sql: `INSERT ${ignore ? "OR IGNORE " : ""}INTO ${table} (_id, accountId, data) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)`,
					params: [param],
				}
	);
}

// Compare-and-swap for many rows: each lands only if its row still holds what was read, and RETURNING names the ones
// that did. writes: { id, accountId, data, before }.
function changeStatements(entry, writes) {
	const table = tableName(entry.collectionName);
	return packRows(writes.map(({ id, accountId, data, before }) => [id, accountId, data, before])).map(({ rows, param }) =>
		rows.length === 1
			? { sql: `UPDATE ${table} SET accountId = ?, data = ? WHERE _id = ? AND data = ? RETURNING _id`, params: [rows[0][1], rows[0][2], rows[0][0], rows[0][3]] }
			: {
					sql: `UPDATE ${table} SET accountId = json_extract(j.value, '$[1]'), data = json_extract(j.value, '$[2]') FROM json_each(?) AS j WHERE ${table}._id = json_extract(j.value, '$[0]') AND ${table}.data = json_extract(j.value, '$[3]') RETURNING _id`,
					params: [param],
				}
	);
}

function landedIds(results) {
	return new Set(results.flatMap(({ rows }) => rows.map((row) => String(row._id))));
}

async function writeChanged(entry, driver, writes) {
	if (writes.length === 0) return new Set();
	return landedIds(await runBatch(entry, driver, changeStatements(entry, writes)));
}

function deleteByIdStatements(entry, ids) {
	const table = tableName(entry.collectionName);
	return packRows(ids.map((id) => [id])).map(({ rows }) => ({
		sql: `DELETE FROM ${table} WHERE _id IN (SELECT value FROM json_each(?))`,
		params: [JSON.stringify(rows.map(([id]) => id))],
	}));
}

function isAccountId(value) {
	return value instanceof ObjectId || (typeof value === "string" && OBJECT_ID_PATTERN.test(value));
}

// Customer data always belongs to one account, and every query on it has to name the account: one without accountId
// throws instead of reading or changing another account's data.
function assertScoped(entry, filter, options) {
	if (!entry.schema.accountScoped || options?.crossAccount) return;
	if (isAccountId(filter?.accountId)) return;
	throw new Error(`${entry.name} query without an accountId`);
}

function equalityFields(filter) {
	const base = {};
	for (const [key, value] of Object.entries(filter)) {
		if (key === "$and") {
			for (const part of value) Object.assign(base, equalityFields(part));
		} else if (!key.startsWith("$") && (value === null || typeof value !== "object" || value instanceof Date)) {
			if (value !== null) base[key] = value;
		} else if (!key.startsWith("$") && value && typeof value === "object" && "$eq" in value) base[key] = value.$eq;
	}
	return base;
}

function expand(flat) {
	const nested = {};
	for (const [path, value] of Object.entries(flat)) {
		const segments = path.split(".");
		let current = nested;
		for (const segment of segments.slice(0, -1)) current = current[segment] ??= {};
		current[segments.at(-1)] = value;
	}
	return nested;
}

// A document the way the app sees it: ObjectId instances where the schema says ObjectId.
function present(entry, doc, selection, { lean }) {
	const hidden = entry.schema.hiddenPaths;
	const projected = selection.include || selection.exclude || hidden.length ? project(doc, selection, hidden) : doc;
	if (!lean && !selection.include && !entry.schema.loose) applyDefaults(entry.schema.root, projected);
	const output = toOutput(entry.schema.root, projected);
	if (output._id !== undefined && entry.schema.idType === "ObjectId" && ObjectId.isValid(output._id)) output._id = new ObjectId(output._id);
	if (!lean) attachDocumentMethods(entry, output);
	return output;
}

function attachDocumentMethods(entry, output) {
	Object.defineProperties(output, {
		id: { value: String(output._id), enumerable: false },
		toObject: { value: () => ({ ...output }), enumerable: false },
		validate: { value: async () => void buildDocument(entry.schema, output), enumerable: false },
		toJSON: { value: () => ({ ...output }), enumerable: false },
	});
}

class DocQuery {
	constructor(entry, operation, args) {
		this.entry = entry;
		this.operation = operation;
		this.args = args;
		this.state = { options: {}, lean: false, select: null, sort: null, limit: null, skip: null };
		const { options } = this.state;
		if (operation === "find" || operation === "findOne") {
			if (args[1]) this.state.select = args[1];
			Object.assign(options, args[2] ?? {});
		} else if (operation === "updateOne" || operation === "updateMany" || operation === "findOneAndUpdate") {
			Object.assign(options, args[2] ?? {});
		} else if (operation === "findById") {
			if (args[1]) this.state.select = args[1];
		}
		if (options.projection) this.state.select = options.projection;
		if (options.sort) this.state.sort = options.sort;
		if (options.limit) this.state.limit = options.limit;
		if (options.lean) this.state.lean = true;
	}

	lean() {
		this.state.lean = true;
		return this;
	}

	select(select) {
		this.state.select = typeof select === "string" && this.state.select ? { ...this.state.select } : select;
		return this;
	}

	sort(sort) {
		this.state.sort = typeof sort === "string" ? Object.fromEntries(sort.split(/\s+/).filter(Boolean).map((key) => (key.startsWith("-") ? [key.slice(1), -1] : [key, 1]))) : sort;
		return this;
	}

	limit(limit) {
		this.state.limit = limit;
		return this;
	}

	skip(skip) {
		this.state.skip = skip;
		return this;
	}

	setOptions(options) {
		Object.assign(this.state.options, options);
		return this;
	}

	getFilter() {
		return this.args[0];
	}

	getOptions() {
		return this.state.options;
	}

	// Mongoose's cursor: next() gives the next document, or null at the end; it also iterates with for await.
	cursor() {
		const iterator = cursorOf(this);
		return {
			async next() {
				const { value, done } = await iterator.next();
				return done ? null : value;
			},
			async close() {
				await iterator.return();
			},
			[Symbol.asyncIterator]: () => iterator,
		};
	}

	toArray() {
		return this.exec();
	}

	exec() {
		return execute(this);
	}

	then(resolve, reject) {
		return this.exec().then(resolve, reject);
	}

	catch(reject) {
		return this.exec().catch(reject);
	}

	finally(callback) {
		return this.exec().finally(callback);
	}
}

function filterOf(query) {
	const { entry, operation, args } = query;
	let filter = operation === "findById" ? { _id: args[0] } : operation === "distinct" ? (args[1] ?? {}) : (args[0] ?? {});
	assertScoped(entry, filter, query.state.options);
	return castFilter(entry.schema, filter);
}

// A query that asks for some fields (select, an aggregate's first $project, exists) has SQLite hand over just those, as columns,
// instead of the whole document: a campaign carries its HTML, up to 200 KB, and a list of campaigns wants a subject and a few
// numbers, so a page that listed 300 of them read tens of megabytes to show a table. Top-level names only; anything else reads the
// document as before. json_type tells a field the document lacks from one that is null, which the rebuilt document keeps apart.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The top-level fields a selection names, or null when it asks for more than a list of them.
export function selectedColumns(paths) {
	if (!Array.isArray(paths)) return null;
	const names = new Set();
	for (const path of paths) {
		const name = String(path).split(".")[0];
		if (!FIELD_NAME.test(name)) return null;
		if (name !== "_id") names.add(name);
	}
	return [...names];
}

function columnsSql(columns) {
	return ["_id AS _id", ...columns.flatMap((name, index) => [`json_extract(data, '$.${name}') AS c${index}`, `json_type(data, '$.${name}') AS t${index}`])].join(", ");
}

function rebuildRow(row, columns) {
	const doc = { _id: row._id };
	columns.forEach((name, index) => {
		const type = row[`t${index}`];
		const value = row[`c${index}`];
		if (type === null || type === undefined) return;
		if (type === "null") doc[name] = null;
		else if (type === "true" || type === "false") doc[name] = type === "true";
		else if (type === "object" || type === "array") doc[name] = JSON.parse(value);
		else doc[name] = value;
	});
	return { data: JSON.stringify(doc) };
}

// Rows matching a filter, in sort order, as stored documents. columns: the fields to read (selectedColumns), when the rows need no more.
async function fetchDocuments(entry, driver, filter, { sort, limit, skip, columns = null }) {
	const { where, params, residual, hasResidual } = splitFilter(entry.schema, filter);
	const order = orderBy(entry.schema, sort);
	const pushDown = order !== null && !hasResidual;
	// The rows are sorted and cut by SQL or read whole: JavaScript would need the fields it sorts and filters by.
	const partial = columns && pushDown ? columns : null;
	let sql = `SELECT ${partial ? columnsSql(partial) : "data"} FROM ${tableName(entry.collectionName)}${where ? ` WHERE ${where}` : ""}`;
	const sortedById = sort && Object.keys(sort).includes("_id");
	sql += ` ORDER BY ${pushDown && order ? `${order}${sortedById ? "" : ", _id"}` : "_id"}`;
	if (pushDown && (limit || skip)) {
		sql += " LIMIT ? OFFSET ?";
		params.push(limit || -1, skip || 0);
	}
	const { rows } = await run(entry, driver, sql, params);
	let documents = rows.map((row) => parseRow(entry, partial ? rebuildRow(row, partial) : row));
	if (pushDown) return documents;
	if (hasResidual) {
		const matcher = new (await loadMingo()).Query(residual);
		documents = documents.filter((doc) => matcher.test(doc));
	}
	if (sort) sortDocuments(documents, sort);
	if (skip) documents = documents.slice(skip);
	if (limit) documents = documents.slice(0, limit);
	return documents;
}

// Every row matching a filter, a page at a time, so a large updateMany or deleteMany never holds them all. One page or
// less is one read. Past that the ids come first, from whichever index suits the filter (paging in _id order would make
// SQLite walk the primary key instead), then each page is read by id with the filter checked again.
async function* scanDocuments(entry, driver, filter) {
	const { where, params, residual, hasResidual } = splitFilter(entry.schema, filter);
	const matcher = hasResidual ? new (await loadMingo()).Query(residual) : null;
	const table = tableName(entry.collectionName);
	const condition = where ? ` WHERE ${where}` : "";
	const read = (rows) => {
		const documents = sortDocuments(rows.map((row) => parseRow(entry, row)), { _id: 1 });
		return matcher ? documents.filter((doc) => matcher.test(doc)) : documents;
	};
	const { rows: head } = await run(entry, driver, `SELECT data FROM ${table}${condition} LIMIT ?`, [...params, BULK_LIMITS.scanPage + 1]);
	if (head.length <= BULK_LIMITS.scanPage) {
		yield read(head);
		return;
	}
	const { rows: found } = await run(entry, driver, `SELECT _id FROM ${table}${condition}`, params);
	const ids = found.map((row) => String(row._id)).sort();
	for (let start = 0; start < ids.length; start += BULK_LIMITS.scanPage) {
		const page = JSON.stringify(ids.slice(start, start + BULK_LIMITS.scanPage));
		// CROSS JOIN keeps json_each outside, so each id is a primary key lookup whatever indexes the filter could use.
		const { rows } = await run(entry, driver, `SELECT ${table}.data FROM json_each(?) AS j CROSS JOIN ${table} ON ${table}._id = j.value${condition}`, [
			page,
			...params,
		]);
		yield read(rows);
	}
}

async function countDocuments(entry, driver, filter) {
	const { where, params, hasResidual } = splitFilter(entry.schema, filter);
	if (hasResidual) return (await fetchDocuments(entry, driver, filter, {})).length;
	const { rows } = await run(entry, driver, `SELECT COUNT(*) AS n FROM ${tableName(entry.collectionName)}${where ? ` WHERE ${where}` : ""}`, params);
	return Number(rows[0].n);
}

// How many documents match a filter for each combination of some of their values, as one GROUP BY the database answers
// from its index: contacts joined each day from each source, counted without reading the contacts. groups: { name: path } or
// { name: { path, slice } }, the first `slice` characters of the value (10 of an ISO date is its day). A filter the database
// can't answer on its own is read and counted here, the same way. Rows come back as { ...values, count }, a missing value null.
async function groupCount(entry, driver, filter, groups) {
	const names = Object.keys(groups);
	const specs = names.map((name) => (typeof groups[name] === "string" ? { path: groups[name] } : groups[name]));
	const { where, params, hasResidual } = splitFilter(entry.schema, filter);
	if (!hasResidual) {
		const columns = specs.map((spec, index) => `${groupExpression(spec.path, spec.slice)} AS g${index}`);
		const by = specs.map((_, index) => `g${index}`).join(", ");
		const sql = `SELECT ${[...columns, "COUNT(*) AS n"].join(", ")} FROM ${tableName(entry.collectionName)}${where ? ` WHERE ${where}` : ""}${by ? ` GROUP BY ${by}` : ""}`;
		const { rows } = await run(entry, driver, sql, params);
		return rows.map((row) => ({ ...Object.fromEntries(names.map((name, index) => [name, row[`g${index}`] ?? null])), count: Number(row.n) }));
	}
	const counts = new Map();
	for (const doc of await fetchDocuments(entry, driver, filter, {})) {
		const values = specs.map(({ path, slice }) => {
			const value = getPath(doc, path);
			if (value === undefined || value === null) return null;
			const text = value instanceof Date ? value.toISOString() : String(value);
			return slice ? text.slice(0, slice) : text;
		});
		const key = JSON.stringify(values);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].map(([key, count]) => ({ ...Object.fromEntries(names.map((name, index) => [name, JSON.parse(key)[index]])), count }));
}

// An update is operators, or an aggregation pipeline ($set stages) that sees the document's own fields.
async function change(doc, update, { inserting = false } = {}) {
	if (Array.isArray(update)) return new (await loadMingo()).Aggregator(update).run([doc])[0];
	return applyUpdate(doc, update, { inserting });
}

function castChange(entry, update) {
	return Array.isArray(update) ? update : castUpdate(entry.schema, update);
}

function idOf(id) {
	return ObjectId.isValid(id) ? new ObjectId(id) : id;
}

function modifiedResult(matched, modified, upserted = null) {
	return {
		acknowledged: true,
		matchedCount: matched,
		modifiedCount: modified,
		upsertedCount: upserted ? 1 : 0,
		upsertedId: upserted,
	};
}

function stamp(entry, update, now) {
	if (Array.isArray(update) || !entry.schema.options.timestamps) return update;
	return { ...update, $set: { updatedAt: now, ...(update.$set ?? {}) } };
}

// One document updated with compare-and-swap: the write only lands if the row still holds what was read, so two
// writers can't both win a claim (D1 has no row locks). Returns { changed, before, after } or null if it didn't match.
async function updateDocument(entry, driver, filter, update, options, sortOverride) {
	for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
		const [before] = await fetchDocuments(entry, driver, filter, { sort: sortOverride, limit: 1 });
		if (!before) return null;
		const now = new Date();
		const after = await change(structuredClone(before), stamp(entry, update, now));
		const serialized = JSON.stringify(after);
		if (serialized === JSON.stringify(before)) return { changed: false, before, after };
		const { changes } = await run(
			entry,
			driver,
			`UPDATE ${tableName(entry.collectionName)} SET accountId = ?, data = ? WHERE _id = ? AND data = ?`,
			[after.accountId ?? null, serialized, String(before._id), JSON.stringify(before)]
		);
		if (changes > 0) return { changed: true, before, after };
	}
	throw new Error(`${entry.name}: could not update, the document kept changing`);
}

async function buildUpserted(entry, filter, update, now) {
	const base = expand(equalityFields(filter));
	const doc = await change(base, stamp(entry, update, now), { inserting: true });
	return buildDocument(entry.schema, doc, { now });
}

async function upsertDocument(entry, driver, filter, update, now) {
	const rebuilt = await buildUpserted(entry, filter, update, now);
	const { sql, params } = insertStatement(entry, rebuilt);
	await run(entry, driver, sql, params);
	return rebuilt;
}

// The columns a select needs: its included fields (and the + ones, which a select of fields adds), when it only includes.
function columnsOf(selection) {
	if (!selection.include || selection.exclude) return null;
	return selectedColumns([...selection.include, ...(selection.extra ?? [])]);
}

async function execute(query) {
	const { entry, operation, args } = query;
	const { state } = query;
	const driver = await ready(entry);
	const selection = parseSelect(state.select);
	const view = (doc) => present(entry, doc, selection, { lean: state.lean });

	switch (operation) {
		case "find": {
			const documents = await fetchDocuments(entry, driver, filterOf(query), { ...state, columns: columnsOf(selection) });
			return documents.map(view);
		}
		case "findOne":
		case "findById": {
			const [doc] = await fetchDocuments(entry, driver, filterOf(query), { ...state, limit: 1, columns: columnsOf(selection) });
			return doc ? view(doc) : null;
		}
		case "exists": {
			const [doc] = await fetchDocuments(entry, driver, filterOf(query), { limit: 1, columns: [] });
			return doc ? { _id: idOf(doc._id) } : null;
		}
		case "countDocuments":
			return countDocuments(entry, driver, filterOf(query));
		case "distinct": {
			const documents = await fetchDocuments(entry, driver, filterOf(query), { columns: selectedColumns([args[0]]) });
			const values = new Map();
			for (const doc of documents) {
				const found = args[0].split(".").reduce((value, segment) => value?.[segment], doc);
				for (const item of Array.isArray(found) ? found : [found]) {
					if (item === undefined || item === null) continue;
					values.set(item instanceof Date ? item.getTime() : item, item);
				}
			}
			const node = entry.schema.resolve(args[0]);
			const leaf = node?.kind === "array" ? node.of : node;
			return [...values.values()].map((value) => (leaf?.kind === "leaf" && leaf.type === "ObjectId" ? new ObjectId(value) : value));
		}
		case "updateOne":
		case "updateMany": {
			const filter = filterOf(query);
			const update = castChange(entry, args[1]);
			const now = new Date();
			if (operation === "updateOne") {
				const result = await updateDocument(entry, driver, filter, update, state.options, state.sort);
				if (result) return modifiedResult(1, result.changed ? 1 : 0);
				if (!state.options.upsert) return modifiedResult(0, 0);
				try {
					const created = await upsertDocument(entry, driver, filter, update, now);
					return modifiedResult(0, 0, idOf(created._id));
				} catch (error) {
					if (error?.code !== 11000) throw error;
					const retry = await updateDocument(entry, driver, filter, update, state.options, state.sort);
					if (!retry) throw error;
					return modifiedResult(1, retry.changed ? 1 : 0);
				}
			}
			let matched = 0;
			let modified = 0;
			for await (const page of scanDocuments(entry, driver, filter)) {
				matched += page.length;
				const writes = [];
				for (const before of page) {
					const after = await change(structuredClone(before), stamp(entry, update, now));
					const data = JSON.stringify(after);
					const original = JSON.stringify(before);
					if (data !== original) writes.push({ id: String(before._id), accountId: after.accountId ?? null, data, before: original });
				}
				const landed = await writeChanged(entry, driver, writes);
				modified += landed.size;
				// Rows that changed between the read and the write are redone one at a time against their new content.
				for (const { id } of writes) {
					if (landed.has(id)) continue;
					const retry = await updateDocument(entry, driver, { $and: [filter, { _id: id }] }, update, state.options);
					if (retry?.changed) modified++;
				}
			}
			if (matched === 0 && state.options.upsert) {
				const created = await upsertDocument(entry, driver, filter, update, now);
				return modifiedResult(0, 0, idOf(created._id));
			}
			return modifiedResult(matched, modified);
		}
		case "findOneAndUpdate": {
			const filter = filterOf(query);
			const update = castChange(entry, args[1]);
			const options = state.options;
			const returnNew = options.new === true || options.returnDocument === "after";
			let result = await updateDocument(entry, driver, filter, update, options, state.sort);
			let doc;
			if (result) doc = returnNew ? result.after : result.before;
			else if (options.upsert) {
				try {
					const created = await upsertDocument(entry, driver, filter, update, new Date());
					doc = returnNew ? created : null;
				} catch (error) {
					if (error?.code !== 11000) throw error;
					result = await updateDocument(entry, driver, filter, update, options, state.sort);
					if (!result) throw error;
					doc = returnNew ? result.after : result.before;
				}
			}
			const value = doc ? view(doc) : null;
			return options.includeResultMetadata ? { value, ok: 1, lastErrorObject: { updatedExisting: Boolean(result) } } : value;
		}
		case "deleteOne":
		case "deleteMany": {
			const filter = filterOf(query);
			const split = splitFilter(entry.schema, filter);
			const table = tableName(entry.collectionName);
			// Not Mongo's: setOptions({ limit }) deletes that many matches at most, so a job can stop and hand the rest on.
			const limit = operation === "deleteMany" && state.options.limit > 0 ? state.options.limit : Infinity;
			// A chunk a statement, so an account's purge never runs into D1's time limit for one statement.
			if (operation === "deleteMany" && !split.hasResidual) {
				let deletedCount = 0;
				while (deletedCount < limit) {
					const chunk = Math.min(BULK_LIMITS.deleteChunk, limit - deletedCount);
					const { changes } = await run(
						entry,
						driver,
						`DELETE FROM ${table} WHERE _id IN (SELECT _id FROM ${table}${split.where ? ` WHERE ${split.where}` : ""} LIMIT ?)`,
						[...split.params, chunk]
					);
					deletedCount += changes;
					if (changes < chunk) break;
				}
				return { acknowledged: true, deletedCount };
			}
			if (operation === "deleteMany") {
				let deletedCount = 0;
				for await (const page of scanDocuments(entry, driver, filter)) {
					const ids = page.slice(0, limit - deletedCount).map((doc) => String(doc._id));
					if (ids.length === 0) continue;
					const results = await runBatch(entry, driver, deleteByIdStatements(entry, ids));
					deletedCount += results.reduce((sum, result) => sum + result.changes, 0);
					if (deletedCount >= limit) break;
				}
				return { acknowledged: true, deletedCount };
			}
			const documents = await fetchDocuments(entry, driver, filter, { limit: 1 });
			if (documents.length === 0) return { acknowledged: true, deletedCount: 0 };
			const results = await runBatch(
				entry,
				driver,
				documents.map((doc) => ({ sql: `DELETE FROM ${table} WHERE _id = ?`, params: [String(doc._id)] }))
			);
			return { acknowledged: true, deletedCount: results.reduce((sum, result) => sum + result.changes, 0) };
		}
		default:
			throw new Error(`Unsupported operation ${operation}`);
	}
}

async function* cursorOf(query) {
	const { entry, state } = query;
	const driver = await ready(entry);
	const selection = parseSelect(state.select);
	const filter = filterOf(query);
	const wanted = state.limit ?? Infinity;
	let skip = state.skip ?? 0;
	let yielded = 0;
	while (yielded < wanted) {
		const page = await fetchDocuments(entry, driver, filter, {
			sort: state.sort ? { ...state.sort, ...(state.sort._id === undefined && { _id: 1 }) } : null,
			limit: Math.min(CURSOR_PAGE, wanted - yielded),
			skip,
		});
		for (const doc of page) yield present(entry, doc, selection, { lean: state.lean });
		yielded += page.length;
		skip += page.length;
		if (page.length < CURSOR_PAGE) return;
	}
}

// ---- Aggregation

class DocAggregate {
	constructor(entry, pipeline) {
		this.entry = entry;
		this.pipeline = pipeline;
		this.options = {};
	}

	option(options) {
		Object.assign(this.options, options);
		return this;
	}

	exec() {
		return runAggregate(this);
	}

	then(resolve, reject) {
		return this.exec().then(resolve, reject);
	}

	catch(reject) {
		return this.exec().catch(reject);
	}
}

function stageDocuments(documents) {
	return documents.map((doc) => structuredClone(doc));
}

// Mongo's pipeline form of $lookup: the joined collection is read once for all the local values, then each local
// document gets its matches, run through the sub-pipeline.
async function lookup(documents, spec) {
	const entry = entriesByCollection.get(spec.from) ?? rawEntry(spec.from);
	const driver = await ready(entry);
	const locals = new Map();
	const wanted = new Set();
	const keyOf = (value) => (value instanceof Date ? value.getTime() : value instanceof ObjectId ? value.toHexString() : value);
	for (const doc of documents) {
		const found = spec.localField.split(".").reduce((value, segment) => value?.[segment], doc);
		const values = (Array.isArray(found) ? found : [found]).filter((value) => value !== undefined && value !== null);
		locals.set(doc, values);
		for (const value of values) wanted.add(keyOf(value));
	}
	const foreignDocs =
		wanted.size > 0
			? await fetchDocuments(entry, driver, castFilter(entry.schema, { [spec.foreignField]: { $in: [...wanted] } }), {})
			: [];
	const byKey = new Map();
	for (const doc of foreignDocs) {
		const found = spec.foreignField.split(".").reduce((value, segment) => value?.[segment], doc);
		for (const item of Array.isArray(found) ? found : [found]) {
			const key = keyOf(item);
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(doc);
		}
	}
	for (const doc of documents) {
		const matches = new Map();
		for (const value of locals.get(doc)) for (const match of byKey.get(keyOf(value)) ?? []) matches.set(String(match._id), match);
		let joined = stageDocuments([...matches.values()]);
		if (spec.pipeline?.length) joined = new (await loadMingo()).Aggregator(spec.pipeline).run(joined);
		doc[spec.as] = joined;
	}
	return documents;
}

const entriesByCollection = new Map();

export function rawEntry(collectionName) {
	const known = entriesByCollection.get(collectionName);
	return { name: collectionName, collectionName, schema: looseSchema(known?.schema.indexes ?? []) };
}

// mingo reads "UTC" as an unknown zone; its fixed offset means the same.
function normalizeTimezones(value) {
	if (Array.isArray(value)) return value.map(normalizeTimezones);
	if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, key === "timezone" && /^(UTC|GMT|Etc\/UTC|Z)$/i.test(item) ? "+00:00" : normalizeTimezones(item)])
		);
	}
	return value;
}

async function runAggregate(aggregate) {
	const { entry, options } = aggregate;
	const pipeline = normalizeTimezones(aggregate.pipeline);
	const driver = await ready(entry);
	const firstMatch = pipeline[0]?.$match;
	assertScoped(entry, firstMatch, options);
	const rest = [...pipeline];
	let filter = {};
	if (firstMatch) {
		filter = castFilter(entry.schema, firstMatch);
		rest.shift();
	}
	// A $project that only names fields to keep is done by SQLite while it reads, when it comes first.
	const kept = rest[0]?.$project;
	const keptNames = kept && Object.entries(kept).every(([name, flag]) => flag === 1 || flag === true || (name === "_id" && flag !== 0 && flag !== false)) ? Object.keys(kept) : null;
	let documents = await fetchDocuments(entry, driver, filter, { columns: keptNames && selectedColumns(keptNames) });
	let segment = [];
	const flush = async () => {
		if (segment.length > 0) documents = new (await loadMingo()).Aggregator(segment).run(documents);
		segment = [];
	};
	for (const stage of rest) {
		if (stage.$lookup) {
			await flush();
			const { from, localField, foreignField, as, pipeline: sub } = stage.$lookup;
			if (!localField || !foreignField) throw new Error("$lookup needs localField and foreignField");
			documents = await lookup(documents, { from, localField, foreignField, as, pipeline: sub });
		} else segment.push(stage);
	}
	await flush();
	return documents;
}

// ---- bulkWrite

// A filter value that SQL and a Map key compare alike: "a" and a Date's ISO string match, 1 and "1" don't.
function valueKey(value) {
	return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

function isPlainValue(value) {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (value instanceof Date && !Number.isNaN(value.getTime()));
}

function touches(update, paths) {
	return Object.values(update).some((fields) =>
		Object.keys(fields ?? {}).some((path) => paths.some((key) => path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`)))
	);
}

// One read for a chunk of updateOne operations, when their filters are equalities on the same scalar paths and differ
// in one of them at most (an import's { accountId, newsletterId, email }): that one becomes an $in. Null when they
// don't, or an update changes a path they filter on, and they run one by one.
function planChunkRead(schema, operations) {
	const keys = Object.keys(operations[0].filter);
	if (keys.length === 0 || !keys.every((key) => isScalarPath(schema, key))) return null;
	for (const { filter, update } of operations) {
		const own = Object.keys(filter);
		if (own.length !== keys.length || !keys.every((key) => key in filter && isPlainValue(filter[key]))) return null;
		if (Array.isArray(update) || touches(update, keys)) return null;
	}
	const varying = keys.filter((key) => operations.some(({ filter }) => valueKey(filter[key]) !== valueKey(operations[0].filter[key])));
	if (varying.length > 1) return null;
	const [by = null] = varying;
	const filter = { ...operations[0].filter };
	if (by) filter[by] = { $in: [...new Map(operations.map((operation) => [valueKey(operation.filter[by]), operation.filter[by]])).values()] };
	return { filter, by };
}

async function updateOneEach(entry, operations) {
	const outcomes = [];
	for (const { filter, update, upsert } of operations) outcomes.push(await execute(new DocQuery(entry, "updateOne", [filter, update, { upsert }])));
	return outcomes;
}

// The same results as running each updateOne in turn, in a few statements: the chunk's documents are read at once, the
// operations applied to them in memory in order (a later one sees what an earlier one did or inserted), and the inserts
// and compare-and-swap writes go in one batch. A duplicate key there (another writer got in first) runs the chunk
// again one by one, and a row that changed since the read gets its operations again one by one.
async function updateOneChunk(entry, operations) {
	const driver = await ready(entry);
	let prepared;
	let plan;
	try {
		prepared = operations.map(({ filter, update, upsert }) => ({ filter: castFilter(entry.schema, filter), update: castChange(entry, update), upsert: Boolean(upsert) }));
		plan = planChunkRead(entry.schema, prepared);
	} catch {
		plan = null;
	}
	if (!plan) return updateOneEach(entry, operations);

	const now = new Date();
	const groups = new Map();
	const keyOf = (doc) => (plan.by ? valueKey(getPath(doc, plan.by)) : "");
	for (const doc of await fetchDocuments(entry, driver, plan.filter, {})) {
		const key = keyOf(doc);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(doc);
	}
	const read = new Map();
	const inserted = new Map();
	const outcomes = [];
	try {
		for (const { filter, update, upsert } of prepared) {
			const key = plan.by ? valueKey(filter[plan.by]) : "";
			const group = groups.get(key) ?? [];
			const [before] = group;
			if (before) {
				const id = String(before._id);
				if (!inserted.has(id) && !read.has(id)) read.set(id, JSON.stringify(before));
				const after = await change(structuredClone(before), stamp(entry, update, now));
				group[0] = after;
				if (inserted.has(id)) inserted.set(id, after);
				outcomes.push({ id, result: modifiedResult(1, JSON.stringify(after) === JSON.stringify(before) ? 0 : 1) });
			} else if (upsert) {
				const created = await buildUpserted(entry, filter, update, now);
				inserted.set(String(created._id), created);
				groups.set(key, [created]);
				outcomes.push({ id: null, result: modifiedResult(0, 0, idOf(created._id)) });
			} else outcomes.push({ id: null, result: modifiedResult(0, 0) });
		}
	} catch {
		return updateOneEach(entry, operations);
	}

	const current = new Map([...groups.values()].flat().map((doc) => [String(doc._id), doc]));
	const writes = [...read]
		.map(([id, before]) => {
			const after = current.get(id);
			return { id, accountId: after.accountId ?? null, data: JSON.stringify(after), before };
		})
		.filter(({ data, before }) => data !== before);
	const updates = changeStatements(entry, writes);
	const statements = [...insertStatements(entry, [...inserted.values()]), ...updates];
	let results;
	try {
		results = statements.length > 0 ? await runBatch(entry, driver, statements) : [];
	} catch (error) {
		if (error?.code === 11000) return updateOneEach(entry, operations);
		throw error;
	}
	const landed = landedIds(results.slice(statements.length - updates.length));
	const missed = new Set(writes.filter(({ id }) => !landed.has(id)).map(({ id }) => id));
	if (missed.size === 0) return outcomes.map(({ result }) => result);
	const redo = [];
	outcomes.forEach(({ id }, index) => missed.has(id) && redo.push(index));
	const again = await updateOneEach(entry, redo.map((index) => operations[index]));
	redo.forEach((index, position) => (outcomes[index].result = again[position]));
	return outcomes.map(({ result }) => result);
}

async function bulkWrite(entry, operations) {
	const result = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0 };
	for (let index = 0; index < operations.length; ) {
		const [type, body] = Object.entries(operations[index])[0];
		if (type === "updateOne") {
			const chunk = [];
			while (index < operations.length && chunk.length < BULK_LIMITS.bulkChunk && operations[index].updateOne) chunk.push(operations[index++].updateOne);
			for (const outcome of await updateOneChunk(entry, chunk)) {
				result.matchedCount += outcome.matchedCount;
				result.modifiedCount += outcome.modifiedCount;
				result.upsertedCount += outcome.upsertedCount;
			}
			continue;
		}
		index++;
		if (type === "insertOne") {
			await createDocuments(entry, [body.document]);
			result.insertedCount++;
		} else if (type === "updateMany") {
			const outcome = await execute(new DocQuery(entry, type, [body.filter, body.update, { upsert: body.upsert }]));
			result.matchedCount += outcome.matchedCount;
			result.modifiedCount += outcome.modifiedCount;
			result.upsertedCount += outcome.upsertedCount;
		} else if (type === "deleteOne" || type === "deleteMany") {
			const outcome = await execute(new DocQuery(entry, type, [body.filter]));
			result.deletedCount += outcome.deletedCount;
		} else throw new Error(`Unsupported bulkWrite operation ${type}`);
	}
	return result;
}

// ---- Creating

async function createDocuments(entry, inputs, { ordered = true, ignoreDuplicates = false } = {}) {
	const driver = await ready(entry);
	const now = new Date();
	const documents = inputs.map((input) => buildDocument(entry.schema, input, { now }));
	if (documents.length === 0) return [];
	if (ignoreDuplicates) {
		const results = await runBatch(entry, driver, insertStatements(entry, documents, { ignore: true }));
		const missed = documents.length - results.reduce((sum, result) => sum + result.changes, 0);
		if (missed > 0) {
			const error = new Error(`E11000 duplicate key error: ${missed} of ${documents.length} documents were already there`);
			error.name = "MongoBulkWriteError";
			error.code = 11000;
			error.writeErrors = Array.from({ length: missed }, () => ({ code: 11000, err: { code: 11000 } }));
			throw error;
		}
	} else await runBatch(entry, driver, insertStatements(entry, documents));
	void ordered;
	return documents;
}

// ---- Models

export function model(name, schema) {
	if (models[name]) return models[name];
	const entry = { name, schema, collectionName: pluralize(name) };
	entriesByCollection.set(entry.collectionName, entry);
	const created = function Model(data) {
		if (!new.target) throw new TypeError("Models are created with new");
		Object.assign(this, data);
		Object.defineProperties(this, {
			validate: { value: async () => void buildDocument(schema, this), enumerable: false },
			toObject: { value: () => ({ ...this }), enumerable: false },
		});
	};
	Object.assign(created, {
		modelName: name,
		schema,
		async init() {
			await ready(entry);
		},
		find: (...args) => new DocQuery(entry, "find", args),
		findOne: (...args) => new DocQuery(entry, "findOne", args),
		findById: (...args) => new DocQuery(entry, "findById", args),
		countDocuments: (...args) => new DocQuery(entry, "countDocuments", args),
		distinct: (...args) => new DocQuery(entry, "distinct", args),
		exists: (...args) => new DocQuery(entry, "exists", args),
		updateOne: (...args) => new DocQuery(entry, "updateOne", args),
		updateMany: (...args) => new DocQuery(entry, "updateMany", args),
		findOneAndUpdate: (...args) => new DocQuery(entry, "findOneAndUpdate", args),
		deleteOne: (...args) => new DocQuery(entry, "deleteOne", args),
		deleteMany: (...args) => new DocQuery(entry, "deleteMany", args),
		aggregate: (pipeline) => new DocAggregate(entry, pipeline),
		async groupCount(filter, groups) {
			assertScoped(entry, filter, {});
			return groupCount(entry, await ready(entry), castFilter(entry.schema, filter), groups);
		},
		async create(input) {
			const many = Array.isArray(input);
			const documents = await createDocuments(entry, many ? input : [input]);
			const shown = documents.map((doc) => present(entry, doc, parseSelect(null), { lean: false }));
			return many ? shown : shown[0];
		},
		async insertMany(inputs, options = {}) {
			const documents = await createDocuments(entry, inputs, { ordered: options.ordered !== false, ignoreDuplicates: options.ordered === false });
			return documents.map((doc) => present(entry, doc, parseSelect(null), { lean: false }));
		},
		async bulkWrite(operations) {
			for (const operation of operations) {
				const [type, body] = Object.entries(operation)[0];
				if (type !== "insertOne") assertScoped(entry, body?.filter, {});
			}
			return bulkWrite(entry, operations);
		},
	});
	Object.defineProperty(created, "collection", { get: () => rawCollection(entry.collectionName) });
	entry.model = created;
	models[name] = created;
	modelEntries.set(created, entry);
	return created;
}

export const modelEntries = new Map();

export function modelEntry(modelOrName) {
	return modelEntries.get(typeof modelOrName === "string" ? models[modelOrName] : modelOrName);
}

export { normalizeMixed };

// The driver-style collection that mongoose.connection.db.collection(name) gave: for Better Auth's tables.
export function rawCollection(name) {
	const entry = rawEntry(name);
	const query = (operation, args) => new DocQuery(entry, operation, args).lean();
	const projectionOf = (options) => ({ projection: options?.projection, sort: options?.sort, limit: options?.limit });
	return {
		collectionName: name,
		findOne: (filter, options) => query("findOne", [filter, null, projectionOf(options)]),
		find: (filter, options) => query("find", [filter, null, projectionOf(options)]),
		countDocuments: (filter) => query("countDocuments", [filter ?? {}]),
		distinct: (field, filter) => query("distinct", [field, filter ?? {}]),
		updateOne: (filter, update, options) => query("updateOne", [filter, update, options ?? {}]),
		updateMany: (filter, update, options) => query("updateMany", [filter, update, options ?? {}]),
		deleteOne: (filter) => query("deleteOne", [filter]),
		deleteMany: (filter) => query("deleteMany", [filter]),
		findOneAndUpdate: (filter, update, options) => query("findOneAndUpdate", [filter, update, options ?? {}]),
		aggregate: (pipeline) => new DocAggregate(entry, pipeline),
		async indexes() {
			await ready(entry);
			const known = entriesByCollection.get(name);
			return [
				{ name: "_id_", key: { _id: 1 } },
				...(known?.schema.indexes ?? []).map(({ fields, options }) => ({
					name: Object.entries(fields).map(([path, direction]) => `${path}_${direction}`).join("_"),
					key: fields,
					...(options.unique && { unique: true }),
					...(options.expireAfterSeconds !== undefined && { expireAfterSeconds: options.expireAfterSeconds }),
					...(options.partialFilterExpression && { partialFilterExpression: options.partialFilterExpression }),
				})),
			];
		},
		async createIndex(fields, options = {}) {
			entry.schema.indexes.push({ fields, options });
			const driver = await ready(entry);
			const index = describeIndexes(name, entry.schema).find((item) => JSON.stringify(item.fields) === JSON.stringify(fields));
			if (!index) return;
			await run(entry, driver, index.sql);
		},
		async insertOne(document) {
			const [doc] = await createDocuments(entry, [document]);
			return { acknowledged: true, insertedId: idOf(doc._id) };
		},
		async insertMany(documents) {
			const docs = await createDocuments(entry, documents);
			return { acknowledged: true, insertedCount: docs.length };
		},
	};
}
