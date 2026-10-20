import { compareValues } from "./schema.js";

// Documents are rows: _id and accountId are columns, everything else is the JSON in data. A filter is split into
// the part SQLite can answer from an index and a leftover that the engine checks in JavaScript, so any Mongo-style
// filter works and the common ones (account, newsletter, status, ids, dates) are answered by the database.

export function tableName(collection) {
	return `c_${collection.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function jsonPath(path) {
	return `$.${path}`;
}

function column(path) {
	if (path === "_id") return "_id";
	if (path === "accountId") return "accountId";
	return `json_extract(data, '${jsonPath(path)}')`;
}

function sqlValue(value) {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

function isPrimitive(value) {
	return value instanceof Date || ["string", "number", "boolean"].includes(typeof value);
}

// A path whose value is one plain scalar: not an array, nothing inside an array. A Mixed field declared with
// scalarMembers (custom field values, keyed by name) holds scalars under its keys, or arrays of scalars (memberCondition).
export function isScalarPath(schema, path) {
	if (path === "_id" || path === "accountId" || schema.loose) return true;
	const segments = path.split(".");
	let node = schema.root;
	for (const segment of segments) {
		if (node.kind === "leaf" && node.type === "Mixed" && node.options.scalarMembers) return true;
		if (node.kind !== "object") return false;
		node = node.fields.get(segment);
		if (!node) return false;
	}
	return node.kind === "leaf" && node.type !== "Mixed";
}

// A path that is a plain array of scalars (tags): Mongo matches a value that equals any element.
function isScalarArrayPath(schema, path) {
	if (schema.loose) return false;
	let node = schema.root;
	for (const segment of path.split(".")) {
		if (node.kind !== "object") return false;
		node = node.fields.get(segment);
		if (!node) return false;
	}
	return node.kind === "array" && node.of.kind === "leaf" && node.of.type !== "Mixed";
}

// A key of a scalarMembers field: its value is a scalar, or an array of scalars (a list field with several choices).
function isMemberPath(schema, path) {
	if (schema.loose) return false;
	let node = schema.root;
	for (const segment of path.split(".")) {
		if (node.kind === "leaf" && node.type === "Mixed" && node.options.scalarMembers) return true;
		if (node.kind !== "object") return false;
		node = node.fields.get(segment);
		if (!node) return false;
	}
	return false;
}

// Equality on a member matches the scalar or any item of the array, as Mongo does: json_each reads a scalar as one row.
function memberCondition(path, operand, params) {
	const equals = (value) => {
		params.push(sqlValue(value));
		return containsElement(path, "value = ?");
	};
	if (isPrimitive(operand)) return equals(operand);
	if (operand === null || typeof operand !== "object" || Array.isArray(operand) || operand instanceof RegExp) return undefined;
	const operators = Object.keys(operand);
	if (operators.length !== 1) return undefined;
	const [operator] = operators;
	const value = operand[operator];
	if (operator === "$eq" && isPrimitive(value)) return equals(value);
	if (operator === "$ne" && isPrimitive(value)) return `NOT ${equals(value)}`;
	return undefined;
}

function containsElement(path, where) {
	return `EXISTS (SELECT 1 FROM json_each(data, '${jsonPath(path)}') WHERE ${where})`;
}

// Equality, $ne, $in, $nin, $all and $exists on an array of scalars, answered in SQL from the row's JSON array.
function arrayCondition(path, operand, params) {
	if (isPrimitive(operand)) {
		params.push(sqlValue(operand));
		return containsElement(path, "value = ?");
	}
	if (operand === null || typeof operand !== "object" || Array.isArray(operand) || operand instanceof RegExp) return null;
	const parts = [];
	for (const [operator, value] of Object.entries(operand)) {
		switch (operator) {
			case "$eq":
			case "$ne":
				if (!isPrimitive(value)) return null;
				params.push(sqlValue(value));
				parts.push(operator === "$eq" ? containsElement(path, "value = ?") : `NOT ${containsElement(path, "value = ?")}`);
				break;
			case "$in":
			case "$nin": {
				if (!Array.isArray(value) || !value.every(isPrimitive)) return null;
				params.push(JSON.stringify(value.map(sqlValue)));
				const found = containsElement(path, "value IN (SELECT value FROM json_each(?))");
				parts.push(operator === "$in" ? found : `NOT ${found}`);
				break;
			}
			case "$all":
				if (!Array.isArray(value) || value.length === 0 || !value.every(isPrimitive)) return null;
				for (const item of value) {
					params.push(sqlValue(item));
					parts.push(containsElement(path, "value = ?"));
				}
				break;
			case "$exists":
				parts.push(`json_type(data, '${jsonPath(path)}') IS ${value ? "NOT " : ""}NULL`);
				break;
			default:
				return null;
		}
	}
	return parts.length > 0 ? parts.join(" AND ") : null;
}

// A regex that is only literal text, with or without ^ and $, as a GLOB: SQLite's GLOB is case sensitive like a regex
// without flags. With no anchor at one end the text may continue there.
function globPrefix(source) {
	const match = /^(\^)?((?:[^.*+?^${}()|[\]\\]|\\[.*+?^${}()|[\]\\\-/])+)(\$)?$/.exec(source);
	if (!match) return null;
	const literal = match[2].replace(/\\(.)/g, "$1").replace(/[*?[\]]/g, (char) => `[${char}]`);
	return `${match[1] ? "" : "*"}${literal}${match[3] ? "" : "*"}`;
}

// unindexed: the term is still checked, but SQLite can't pick an index for it (a unary + is a no-op on the value).
function condition(schema, path, operand, params, unindexed = false) {
	if (isScalarArrayPath(schema, path)) return arrayCondition(path, operand, params);
	if (isMemberPath(schema, path)) {
		const member = memberCondition(path, operand, params);
		if (member !== undefined) return member;
	}
	if (!isScalarPath(schema, path)) return null;
	const col = unindexed ? `+${column(path)}` : column(path);
	if (operand === null) return `${col} IS NULL`;
	if (isPrimitive(operand)) {
		params.push(sqlValue(operand));
		return `${col} = ?`;
	}
	if (operand instanceof RegExp) {
		const glob = !operand.flags && globPrefix(operand.source);
		if (!glob) return null;
		params.push(glob);
		return `${col} GLOB ?`;
	}
	if (typeof operand !== "object" || Array.isArray(operand)) return null;
	const parts = [];
	let regexSource = null;
	let regexOptions = "";
	for (const [operator, value] of Object.entries(operand)) {
		switch (operator) {
			case "$eq": {
				const part = condition(schema, path, value, params, unindexed);
				if (!part) return null;
				parts.push(part);
				break;
			}
			case "$ne":
				if (value === null) parts.push(`${col} IS NOT NULL`);
				else if (isPrimitive(value)) {
					params.push(sqlValue(value));
					parts.push(`(${col} IS NULL OR ${col} != ?)`);
				} else return null;
				break;
			case "$gt":
			case "$gte":
			case "$lt":
			case "$lte":
				if (!isPrimitive(value)) return null;
				params.push(sqlValue(value));
				parts.push(`${col} ${{ $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[operator]} ?`);
				break;
			case "$in":
			case "$nin": {
				if (!value.every((item) => item === null || isPrimitive(item))) return null;
				const present = value.filter((item) => item !== null).map(sqlValue);
				const hasNull = present.length !== value.length;
				params.push(JSON.stringify(present));
				const list = `SELECT value FROM json_each(?)`;
				if (operator === "$in") parts.push(hasNull ? `(${col} IN (${list}) OR ${col} IS NULL)` : `${col} IN (${list})`);
				else parts.push(hasNull ? `(${col} IS NOT NULL AND ${col} NOT IN (${list}))` : `(${col} IS NULL OR ${col} NOT IN (${list}))`);
				break;
			}
			case "$exists":
				parts.push(value ? `${path === "_id" || path === "accountId" ? col : `json_type(data, '${jsonPath(path)}')`} IS NOT NULL` : `${path === "_id" || path === "accountId" ? col : `json_type(data, '${jsonPath(path)}')`} IS NULL`);
				break;
			case "$regex":
				regexSource = value instanceof RegExp ? value.source : String(value);
				break;
			case "$options":
				regexOptions = value;
				break;
			default:
				return null;
		}
	}
	if (regexSource !== null) {
		const glob = !regexOptions && globPrefix(regexSource);
		if (!glob) return null;
		params.push(glob);
		parts.push(`${col} GLOB ?`);
	}
	return parts.length > 0 ? parts.join(" AND ") : null;
}

// { where, params, residual }: SQL for what SQLite can check, and the filter for what's left.
export function splitFilter(schema, filter) {
	const params = [];
	const flat = translateTop(schema, filter, params);
	return { where: flat.sql, params, residual: flat.residual, hasResidual: flat.residualKeys > 0 };
}

function isLookup(operand) {
	if (isPrimitive(operand)) return true;
	if (!operand || typeof operand !== "object" || Array.isArray(operand) || operand instanceof RegExp) return false;
	const operators = Object.keys(operand);
	return operators.length === 1 && ((operators[0] === "$eq" && isPrimitive(operand.$eq)) || (operators[0] === "$in" && Array.isArray(operand.$in)));
}

function leafOf(schema, path) {
	if (schema.loose) return null;
	const node = schema.resolve(path);
	return node?.kind === "leaf" ? node : null;
}

// SQLite has no statistics on these tables, so it favors the index that covers the most terms, and takes
// { accountId, status: "active", email: { $in: [...] } } through (accountId, status): every active contact of the
// account, rather than the few with those addresses. Terms a better one makes worthless are left off the indexes: all
// of them beside an _id lookup, and the ones with a handful of values (an enum, a boolean) beside a lookup of an
// indexed text field.
function unindexedTerms(schema, filter) {
	const keys = Object.keys(filter).filter((key) => !key.startsWith("$"));
	if (keys.includes("_id") && isLookup(filter._id)) return new Set(keys.filter((key) => key !== "_id"));
	const isIndexedText = (key) => {
		const leaf = leafOf(schema, key);
		return leaf?.type === "String" && !leaf.options.enum && schema.indexes.some(({ fields }) => key in fields);
	};
	if (!keys.some((key) => isLookup(filter[key]) && isIndexedText(key))) return new Set();
	return new Set(
		keys.filter((key) => {
			const leaf = leafOf(schema, key);
			return Boolean(leaf?.options.enum) || leaf?.type === "Boolean";
		})
	);
}

function translateTop(schema, filter, params) {
	const clauses = [];
	const residual = {};
	const unindexed = unindexedTerms(schema, filter);
	for (const [key, operand] of Object.entries(filter)) {
		if (key === "$and") {
			const nested = operand.map((part) => splitFilter(schema, part));
			for (const part of nested) {
				if (part.where) {
					clauses.push(`(${part.where})`);
					params.push(...part.params);
				}
				if (part.hasResidual) (residual.$and ??= []).push(part.residual);
			}
			continue;
		}
		if (key === "$or") {
			const nested = operand.map((part) => splitFilter(schema, part));
			if (nested.length > 0 && nested.every((part) => !part.hasResidual && part.where)) {
				clauses.push(`(${nested.map((part) => `(${part.where})`).join(" OR ")})`);
				for (const part of nested) params.push(...part.params);
			} else residual.$or = operand;
			continue;
		}
		if (key.startsWith("$")) {
			residual[key] = operand;
			continue;
		}
		const mark = params.length;
		const sql = condition(schema, key, operand, params, unindexed.has(key));
		if (sql) clauses.push(sql);
		else {
			params.length = mark;
			residual[key] = operand;
		}
	}
	return { sql: clauses.join(" AND "), residual, residualKeys: Object.keys(residual).length };
}

export function orderBy(schema, sort) {
	const entries = Object.entries(sort ?? {});
	if (entries.length === 0) return "";
	const parts = [];
	for (const [path, direction] of entries) {
		if (!isScalarPath(schema, path)) return null;
		parts.push(`${column(path)} ${direction < 0 || direction === "desc" ? "DESC" : "ASC"}`);
	}
	return parts.join(", ");
}

export function sortDocuments(documents, sort) {
	const entries = Object.entries(sort ?? {});
	if (entries.length === 0) return documents;
	const read = (doc, path) => path.split(".").reduce((value, segment) => value?.[segment], doc);
	return documents.sort((a, b) => {
		for (const [path, direction] of entries) {
			const order = compareValues(read(a, path), read(b, path));
			if (order !== 0) return direction < 0 || direction === "desc" ? -order : order;
		}
		return 0;
	});
}

// ---- Schema

function indexName(collection, fields, unique) {
	const body = Object.entries(fields)
		.map(([path, direction]) => `${path.replace(/[^a-zA-Z0-9]/g, "_")}${direction < 0 ? "_d" : ""}`)
		.join("__");
	return `${unique ? "u" : "i"}_${collection}__${body}`.slice(0, 120);
}

function partialWhere(expression, sparseField) {
	const clauses = [];
	if (sparseField) clauses.push(`${column(sparseField)} IS NOT NULL`);
	for (const [path, condition] of Object.entries(expression ?? {})) {
		if (condition?.$type === "string") clauses.push(`json_type(data, '${jsonPath(path)}') = 'text'`);
		else if (condition?.$exists === true) clauses.push(`${path === "_id" ? "_id" : `json_type(data, '${jsonPath(path)}')`} IS NOT NULL`);
		else if (typeof condition === "string") clauses.push(`${column(path)} = '${condition.replace(/'/g, "''")}'`);
		else if (condition?.$exists === false) clauses.push(`json_type(data, '${jsonPath(path)}') IS NULL`);
		else throw new Error(`Unsupported partial index condition on ${path}`);
	}
	return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

export function describeIndexes(collection, schema) {
	const seen = new Set();
	const indexes = [];
	for (const { fields, options } of schema.indexes) {
		if (options.expireAfterSeconds !== undefined) continue;
		const unique = Boolean(options.unique);
		const name = indexName(collection, fields, unique);
		if (seen.has(name)) continue;
		seen.add(name);
		const first = Object.keys(fields)[0];
		// MongoDB counts a missing field as null, and two nulls collide in a unique index; SQLite never lets NULLs collide.
		const keepsNulls = unique && !options.partialFilterExpression && !options.sparse && !options.plain;
		const columns = Object.entries(fields)
			.map(([path, direction]) => {
				// Only fields that can be missing need it: a plain expression is what a lookup on that field can use.
				const optional = keepsNulls && !schema.resolve(path)?.options?.required;
				return `${optional ? `IFNULL(${column(path)}, '')` : column(path)} ${direction < 0 ? "DESC" : "ASC"}`;
			})
			.join(", ");
		indexes.push({
			name,
			unique,
			fields,
			sql: `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON ${tableName(collection)} (${columns})${partialWhere(options.partialFilterExpression, options.sparse ? first : null)}`,
		});
	}
	return indexes;
}

export function schemaStatements(collection, schema) {
	const table = tableName(collection);
	return [
		`CREATE TABLE IF NOT EXISTS ${table} (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS i_${collection}__accountId ON ${table} (accountId)`,
		...describeIndexes(collection, schema).map((index) => index.sql),
	];
}
