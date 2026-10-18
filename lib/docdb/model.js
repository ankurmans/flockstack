import { Aggregator, Query as MongoQuery } from "mingo";
import { getDriver } from "./driver.js";
import { ObjectId, OBJECT_ID_PATTERN } from "./object-id.js";
import {
	applyDefaults,
	looseSchema,
	applyUpdate,
	buildDocument,
	castFilter,
	castUpdate,
	normalizeMixed,
	parseSelect,
	project,
	reviveDates,
	toOutput,
} from "./schema.js";
import { describeIndexes, orderBy, schemaStatements, sortDocuments, splitFilter, tableName } from "./sql.js";

// The Mongoose subset this app uses, over SQLite rows: Model.find / findOne / updateOne / aggregate... with the same
// filter and update operators, results and errors (code 11000 on a duplicate key).

export const models = {};

const CURSOR_PAGE = 500;
const CAS_RETRIES = 5;

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

// Rows matching a filter, in sort order, as stored documents.
async function fetchDocuments(entry, driver, filter, { sort, limit, skip }) {
	const { where, params, residual, hasResidual } = splitFilter(entry.schema, filter);
	const order = orderBy(entry.schema, sort);
	const pushDown = order !== null && !hasResidual;
	let sql = `SELECT data FROM ${tableName(entry.collectionName)}${where ? ` WHERE ${where}` : ""}`;
	const sortedById = sort && Object.keys(sort).includes("_id");
	sql += ` ORDER BY ${pushDown && order ? `${order}${sortedById ? "" : ", _id"}` : "_id"}`;
	if (pushDown && (limit || skip)) {
		sql += " LIMIT ? OFFSET ?";
		params.push(limit || -1, skip || 0);
	}
	const { rows } = await run(entry, driver, sql, params);
	let documents = rows.map((row) => parseRow(entry, row));
	if (pushDown) return documents;
	if (hasResidual) {
		const matcher = new MongoQuery(residual);
		documents = documents.filter((doc) => matcher.test(doc));
	}
	if (sort) sortDocuments(documents, sort);
	if (skip) documents = documents.slice(skip);
	if (limit) documents = documents.slice(0, limit);
	return documents;
}

async function countDocuments(entry, driver, filter) {
	const { where, params, hasResidual } = splitFilter(entry.schema, filter);
	if (hasResidual) return (await fetchDocuments(entry, driver, filter, {})).length;
	const { rows } = await run(entry, driver, `SELECT COUNT(*) AS n FROM ${tableName(entry.collectionName)}${where ? ` WHERE ${where}` : ""}`, params);
	return Number(rows[0].n);
}

// An update is operators, or an aggregation pipeline ($set stages) that sees the document's own fields.
function change(doc, update, { inserting = false } = {}) {
	if (Array.isArray(update)) return new Aggregator(update).run([doc])[0];
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
		const after = change(structuredClone(before), stamp(entry, update, now));
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

async function upsertDocument(entry, driver, filter, update, now) {
	const base = expand(equalityFields(filter));
	const doc = change(base, stamp(entry, update, now), { inserting: true });
	const rebuilt = buildDocument(entry.schema, doc, { now });
	const { sql, params } = insertStatement(entry, rebuilt);
	await run(entry, driver, sql, params);
	return rebuilt;
}

async function execute(query) {
	const { entry, operation, args } = query;
	const { state } = query;
	const driver = await ready(entry);
	const selection = parseSelect(state.select);
	const view = (doc) => present(entry, doc, selection, { lean: state.lean });

	switch (operation) {
		case "find": {
			const documents = await fetchDocuments(entry, driver, filterOf(query), state);
			return documents.map(view);
		}
		case "findOne":
		case "findById": {
			const [doc] = await fetchDocuments(entry, driver, filterOf(query), { ...state, limit: 1 });
			return doc ? view(doc) : null;
		}
		case "exists": {
			const [doc] = await fetchDocuments(entry, driver, filterOf(query), { limit: 1 });
			return doc ? { _id: idOf(doc._id) } : null;
		}
		case "countDocuments":
			return countDocuments(entry, driver, filterOf(query));
		case "distinct": {
			const documents = await fetchDocuments(entry, driver, filterOf(query), {});
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
			const documents = await fetchDocuments(entry, driver, filter, {});
			if (documents.length === 0 && state.options.upsert) {
				const created = await upsertDocument(entry, driver, filter, update, now);
				return modifiedResult(0, 0, idOf(created._id));
			}
			let modified = 0;
			const writes = [];
			for (const before of documents) {
				const after = change(structuredClone(before), stamp(entry, update, now));
				const serialized = JSON.stringify(after);
				if (serialized === JSON.stringify(before)) continue;
				writes.push({
					sql: `UPDATE ${tableName(entry.collectionName)} SET accountId = ?, data = ? WHERE _id = ? AND data = ?`,
					params: [after.accountId ?? null, serialized, String(before._id), JSON.stringify(before)],
				});
			}
			if (writes.length > 0) {
				const results = await runBatch(entry, driver, writes);
				modified = results.reduce((sum, result) => sum + result.changes, 0);
				// Rows that changed between the read and the write are redone one at a time against their new content.
				for (let index = 0; index < results.length; index++) {
					if (results[index].changes > 0) continue;
					const id = writes[index].params[2];
					const retry = await updateDocument(entry, driver, { $and: [filter, { _id: id }] }, update, state.options);
					if (retry?.changed) modified++;
				}
			}
			return modifiedResult(documents.length, modified);
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
			if (operation === "deleteMany" && !split.hasResidual) {
				const { changes } = await run(entry, driver, `DELETE FROM ${table}${split.where ? ` WHERE ${split.where}` : ""}`, split.params);
				return { acknowledged: true, deletedCount: changes };
			}
			const documents = await fetchDocuments(entry, driver, filter, { limit: operation === "deleteOne" ? 1 : null });
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
		if (spec.pipeline?.length) joined = new Aggregator(spec.pipeline).run(joined);
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
	let documents = await fetchDocuments(entry, driver, filter, {});
	let segment = [];
	const flush = () => {
		if (segment.length > 0) documents = new Aggregator(segment).run(documents);
		segment = [];
	};
	for (const stage of rest) {
		if (stage.$lookup) {
			flush();
			const { from, localField, foreignField, as, pipeline: sub } = stage.$lookup;
			if (!localField || !foreignField) throw new Error("$lookup needs localField and foreignField");
			documents = await lookup(documents, { from, localField, foreignField, as, pipeline: sub });
		} else segment.push(stage);
	}
	flush();
	return documents;
}

// ---- bulkWrite

async function bulkWrite(entry, operations) {
	const result = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0 };
	for (const operation of operations) {
		const [type, body] = Object.entries(operation)[0];
		if (type === "insertOne") {
			await createDocuments(entry, [body.document]);
			result.insertedCount++;
		} else if (type === "updateOne" || type === "updateMany") {
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
		const results = await runBatch(entry, driver, documents.map((doc) => insertStatement(entry, doc, { ignore: true })));
		const missed = results.filter((result) => result.changes === 0).length;
		if (missed > 0) {
			const error = new Error(`E11000 duplicate key error: ${missed} of ${documents.length} documents were already there`);
			error.name = "MongoBulkWriteError";
			error.code = 11000;
			error.writeErrors = Array.from({ length: missed }, () => ({ code: 11000, err: { code: 11000 } }));
			throw error;
		}
	} else await runBatch(entry, driver, documents.map((doc) => insertStatement(entry, doc)));
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
