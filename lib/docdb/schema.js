import { ObjectId } from "./object-id.js";

// The schema half of the document layer: what a model's documents look like, how a value is cast and validated, and
// how a new document or an update is built. It covers what the models in models/ use of Mongoose's Schema, no more.

class ObjectIdType {}
class MixedType {}

const SCALARS = new Map([
	[String, "String"],
	[Number, "Number"],
	[Boolean, "Boolean"],
	[Date, "Date"],
	[ObjectIdType, "ObjectId"],
	[ObjectId, "ObjectId"],
	[MixedType, "Mixed"],
]);

export class ValidationError extends Error {
	constructor(errors) {
		const first = Object.values(errors)[0];
		super(`Validation failed: ${Object.entries(errors).map(([path, { message }]) => `${path}: ${message}`).join(", ")}`);
		this.name = "ValidationError";
		this.errors = errors;
		this.reason = first;
	}
}

export class CastError extends Error {
	constructor(type, value, path) {
		super(`Cast to ${type} failed for value "${String(value)}" at path "${path}"`);
		this.name = "CastError";
		this.kind = type;
		this.value = value;
		this.path = path;
	}
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isTypeMarker(value) {
	return typeof value === "function" || SCALARS.has(value);
}

// { type: String, ... } is a field with options. { type: { type: String } } is an object that has a field named type.
function isLeafSpec(value) {
	return isPlainObject(value) && "type" in value && (isTypeMarker(value.type) || Array.isArray(value.type));
}

function scalarType(marker) {
	const type = SCALARS.get(marker);
	if (!type) throw new Error(`Unsupported schema type: ${marker?.name ?? marker}`);
	return type;
}

function parseField(spec) {
	if (Array.isArray(spec)) return parseArray(spec, {});
	if (isTypeMarker(spec)) return { kind: "leaf", type: scalarType(spec), options: {} };
	if (isLeafSpec(spec)) {
		if (Array.isArray(spec.type)) return parseArray(spec.type, spec);
		const { type, ...options } = spec;
		return { kind: "leaf", type: scalarType(type), options };
	}
	if (isPlainObject(spec)) return parseObject(spec);
	throw new Error("Unsupported schema definition");
}

function parseArray(items, options) {
	const [element] = items;
	if (element === undefined) return { kind: "array", of: { kind: "leaf", type: "Mixed", options: {} }, options };
	return { kind: "array", of: parseField(element), options };
}

function parseObject(definition) {
	const fields = new Map();
	for (const [key, spec] of Object.entries(definition)) {
		if (key === "_id" && spec === false) continue;
		fields.set(key, parseField(spec));
	}
	return { kind: "object", fields };
}

export class Schema {
	static Types = { ObjectId: ObjectIdType, Mixed: MixedType };

	constructor(definition, options = {}) {
		this.options = options;
		this.root = parseObject(definition);
		this.indexes = [];
		this.accountScoped = false;
		if (options.timestamps) {
			for (const path of ["createdAt", "updatedAt"]) if (!this.root.fields.has(path)) this.root.fields.set(path, { kind: "leaf", type: "Date", options: {} });
		}
		this.#collectFieldIndexes(this.root, "");
	}

	add(definition) {
		for (const [key, spec] of Object.entries(definition)) this.root.fields.set(key, parseField(spec));
		this.#collectFieldIndexes(this.root, "");
		return this;
	}

	index(fields, options = {}) {
		this.indexes.push({ fields, options });
		return this;
	}

	plugin(fn, options) {
		fn(this, options);
		return this;
	}

	#collectFieldIndexes(node, prefix) {
		for (const [key, child] of node.fields) {
			const path = prefix + key;
			if (child.kind === "object") this.#collectFieldIndexes(child, `${path}.`);
			else if (child.kind === "leaf" && (child.options.unique || child.options.index)) {
				if (this.indexes.some((entry) => entry.auto === path)) continue;
				this.indexes.push({ fields: { [path]: 1 }, options: child.options.unique ? { unique: true } : {}, auto: path });
			}
		}
	}

	// The paths that a read leaves out unless the query asks for them (select: false).
	get hiddenPaths() {
		const hidden = [];
		const walk = (node, prefix) => {
			for (const [key, child] of node.fields) {
				if (child.kind === "object") walk(child, `${prefix}${key}.`);
				else if (child.kind === "leaf" && child.options.select === false) hidden.push(prefix + key);
			}
		};
		walk(this.root, "");
		return hidden;
	}

	get idType() {
		const id = this.root.fields.get("_id");
		return id?.kind === "leaf" ? id.type : "ObjectId";
	}

	// The node a dotted path leads to: through array elements and subdocuments, with numeric and positional segments skipped.
	resolve(path) {
		let node = this.root;
		for (const segment of path.split(".")) {
			if (node.kind === "array") {
				node = node.of;
				if (/^(\d+|\$)$/.test(segment)) continue;
			}
			if (node.kind === "leaf") return node.type === "Mixed" ? { kind: "leaf", type: "Mixed", options: {} } : null;
			if (node.kind !== "object") return null;
			const next = node.fields.get(segment);
			if (!next) {
				if (segment === "_id" && node === this.root) return { kind: "leaf", type: this.idType, options: {} };
				return null;
			}
			node = next;
		}
		return node;
	}
}

// A schema that accepts any document: for collections owned by someone else, like Better Auth's tables.
export function looseSchema(indexes = []) {
	const schema = new Schema({});
	schema.loose = true;
	schema.indexes = indexes;
	schema.resolve = () => ({ kind: "leaf", type: "Mixed", options: {} });
	return schema;
}

// ---- Casting

function castScalar(type, value, path, options = {}) {
	if (value === null || value === undefined) return value;
	switch (type) {
		case "String": {
			if (typeof value === "object" && !(value instanceof ObjectId)) throw new CastError("string", value, path);
			let text = String(value);
			if (options.trim) text = text.trim();
			if (options.lowercase) text = text.toLowerCase();
			return text;
		}
		case "Number": {
			const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
			if (Number.isNaN(number)) throw new CastError("Number", value, path);
			return number;
		}
		case "Boolean":
			if (typeof value === "boolean") return value;
			if (value === "true" || value === 1 || value === "1") return true;
			if (value === "false" || value === 0 || value === "0") return false;
			throw new CastError("Boolean", value, path);
		case "Date": {
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) throw new CastError("date", value, path);
			return date;
		}
		case "ObjectId": {
			if (!ObjectId.isValid(value instanceof ObjectId ? value : String(value))) throw new CastError("ObjectId", value, path);
			return String(value).toLowerCase();
		}
		default:
			return normalizeMixed(value);
	}
}

// Mixed values and filters keep their shape, but an ObjectId becomes its hex string, the way it's stored.
export function normalizeMixed(value) {
	if (value instanceof ObjectId) return value.toHexString();
	if (Array.isArray(value)) return value.map(normalizeMixed);
	if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeMixed(item)]));
	return value;
}

function validateLeaf(node, value, path, errors) {
	const { options } = node;
	if (value === undefined || value === null) return;
	if (options.enum && !options.enum.includes(value)) errors[path] = { message: `\`${value}\` is not a valid enum value for path \`${path}\`.`, kind: "enum" };
	if (options.min !== undefined && typeof value === "number" && value < options.min) {
		errors[path] = { message: `Path \`${path}\` (${value}) is less than minimum allowed value (${options.min}).`, kind: "min" };
	}
}

function isMissing(value) {
	return value === undefined || value === null || value === "";
}

// A new document's stored shape: defaults, casts and setters applied, unknown fields dropped, required fields checked.
export function buildDocument(schema, input, { now = new Date() } = {}) {
	if (schema.loose) {
		const copy = normalizeMixed({ ...input });
		copy._id = copy._id === undefined ? new ObjectId().toHexString() : String(copy._id);
		return copy;
	}
	const errors = {};
	const doc = buildObject(schema.root, input ?? {}, "", errors, schema.root);
	if (schema.root.fields.has("_id") === false || schema.idType === "ObjectId") {
		if (doc._id === undefined) doc._id = new ObjectId().toHexString();
		else doc._id = castScalar("ObjectId", doc._id, "_id");
	} else if (isMissing(doc._id)) {
		errors._id = { message: "Path `_id` is required.", kind: "required" };
	}
	if (schema.options.timestamps) {
		doc.createdAt ??= now;
		doc.updatedAt ??= now;
	}
	if (Object.keys(errors).length > 0) throw new ValidationError(errors);
	return doc;
}

function buildObject(node, input, prefix, errors, root) {
	const result = {};
	for (const [key, child] of node.fields) {
		const path = prefix + key;
		const value = buildValue(child, input?.[key], path, errors);
		if (value !== undefined) result[key] = value;
		else if (child.kind === "leaf" && child.options.required) errors[path] = { message: `Path \`${path}\` is required.`, kind: "required" };
	}
	if (node !== root) return Object.keys(result).length > 0 ? result : undefined;
	for (const key of ["_id"]) if (!node.fields.has(key) && input?.[key] !== undefined) result[key] = input[key];
	return result;
}

function buildValue(node, input, path, errors) {
	if (node.kind === "object") return buildObject(node, input, `${path}.`, errors, null);
	if (node.kind === "array") {
		if (input === undefined || input === null) {
			if ("default" in node.options && node.options.default === undefined) return undefined;
			return [];
		}
		return (Array.isArray(input) ? input : [input]).map((item, index) => {
			const built = buildValue(node.of, item, `${path}.${index}`, errors);
			return built ?? null;
		});
	}
	let value = input;
	if (value === undefined && "default" in node.options) value = typeof node.options.default === "function" ? node.options.default() : node.options.default;
	if (value === undefined) return undefined;
	let cast;
	try {
		cast = castScalar(node.type, value, path, node.options);
	} catch (error) {
		errors[path] = { message: error.message, kind: "cast" };
		return undefined;
	}
	if (node.options.required && isMissing(cast)) {
		errors[path] = { message: `Path \`${path}\` is required.`, kind: "required" };
		return undefined;
	}
	validateLeaf(node, cast, path, errors);
	return cast;
}

// ---- Update operators

function isNumericSegment(segment) {
	return /^\d+$/.test(segment);
}

export function getPath(target, path) {
	let current = target;
	for (const segment of path.split(".")) {
		if (current === null || current === undefined) return undefined;
		current = current[segment];
	}
	return current;
}

export function setPath(target, path, value) {
	const segments = path.split(".");
	let current = target;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		if (current[segment] === null || typeof current[segment] !== "object") current[segment] = isNumericSegment(segments[index + 1]) ? [] : {};
		current = current[segment];
	}
	current[segments.at(-1)] = value;
}

export function unsetPath(target, path) {
	const segments = path.split(".");
	let current = target;
	for (let index = 0; index < segments.length - 1; index++) {
		current = current?.[segments[index]];
		if (current === null || typeof current !== "object") return;
	}
	if (Array.isArray(current)) current[Number(segments.at(-1))] = null;
	else delete current?.[segments.at(-1)];
}

function castForPath(schema, path, value, element = false) {
	let node = schema.resolve(path);
	if (!node) return { known: false, value: normalizeMixed(value) };
	if (element && node.kind === "array") node = node.of;
	if (node.kind === "leaf") return { known: true, value: castScalar(node.type, value, path, node.options) };
	if (node.kind === "array") {
		const items = (Array.isArray(value) ? value : [value]).map((item) =>
			node.of.kind === "leaf" ? castScalar(node.of.type, item, path, node.of.options) : buildObject(node.of, item, "", {}, null) ?? {}
		);
		return { known: true, value: items };
	}
	return { known: true, value: buildObject(node, value, `${path}.`, {}, null) ?? {} };
}

// Strict, like Mongoose: an update naming a field the schema doesn't have leaves it out. Values are cast the way
// the schema's fields cast them.
export function castUpdate(schema, update) {
	const cast = {};
	const keys = Object.keys(update);
	if (keys.length > 0 && keys.every((key) => !key.startsWith("$"))) update = { $set: update };
	for (const [operator, fields] of Object.entries(update)) {
		if (!operator.startsWith("$")) throw new Error("Updates must use operators like $set");
		cast[operator] = {};
		for (const [path, value] of Object.entries(fields ?? {})) {
			if (operator === "$unset") {
				if (schema.resolve(path)) cast[operator][path] = 1;
				continue;
			}
			const isArrayOp = operator === "$push" || operator === "$addToSet" || operator === "$pull";
			const result = castForPath(schema, path, value, isArrayOp);
			if (result.known) cast[operator][path] = result.value;
		}
	}
	return cast;
}

export function compareValues(a, b) {
	const rank = (value) => (value === null || value === undefined ? 0 : typeof value === "number" || value instanceof Date ? 1 : typeof value === "string" ? 2 : 3);
	const ra = rank(a);
	const rb = rank(b);
	if (ra !== rb) return ra - rb;
	if (ra === 0) return 0;
	const x = a instanceof Date ? a.getTime() : a;
	const y = b instanceof Date ? b.getTime() : b;
	return x < y ? -1 : x > y ? 1 : 0;
}

function equalValues(a, b) {
	return compareValues(a, b) === 0 && (a instanceof Date) === (b instanceof Date);
}

// Applies cast update operators to a stored-shape document in place. Returns the same document.
export function applyUpdate(doc, update, { inserting = false } = {}) {
	for (const [operator, fields] of Object.entries(update)) {
		for (const [path, value] of Object.entries(fields)) {
			const current = getPath(doc, path);
			switch (operator) {
				case "$set":
					setPath(doc, path, value);
					break;
				case "$setOnInsert":
					if (inserting) setPath(doc, path, value);
					break;
				case "$unset":
					unsetPath(doc, path);
					break;
				case "$inc":
					setPath(doc, path, (typeof current === "number" ? current : 0) + value);
					break;
				case "$min":
					if (current === undefined || current === null || compareValues(value, current) < 0) setPath(doc, path, value);
					break;
				case "$max":
					if (current === undefined || current === null || compareValues(value, current) > 0) setPath(doc, path, value);
					break;
				case "$push":
					setPath(doc, path, [...(Array.isArray(current) ? current : []), ...value]);
					break;
				case "$addToSet": {
					const list = Array.isArray(current) ? [...current] : [];
					for (const item of value) if (!list.some((existing) => equalValues(existing, item))) list.push(item);
					setPath(doc, path, list);
					break;
				}
				case "$pull":
					if (Array.isArray(current)) setPath(doc, path, current.filter((item) => !value.some((target) => equalValues(item, target))));
					break;
				case "$currentDate":
					setPath(doc, path, new Date());
					break;
				default:
					throw new Error(`Unsupported update operator ${operator}`);
			}
		}
	}
	return doc;
}

// ---- Filters

const COMPARISON = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);
const LISTS = new Set(["$in", "$nin", "$all"]);

function castCondition(schema, path, condition) {
	const node = schema.resolve(path);
	const leaf = node?.kind === "array" ? node.of : node;
	const toType = (value) => {
		if (!leaf || leaf.kind !== "leaf") return normalizeMixed(value);
		if (value === null || value === undefined) return value;
		if (value instanceof RegExp) return value;
		return castScalar(leaf.type, value, path, { ...leaf.options, trim: false, lowercase: false });
	};
	if (condition === null || typeof condition !== "object" || condition instanceof Date || condition instanceof ObjectId || condition instanceof RegExp || Array.isArray(condition)) {
		if (Array.isArray(condition)) return condition.map(toType);
		return toType(condition);
	}
	const result = {};
	for (const [operator, operand] of Object.entries(condition)) {
		if (COMPARISON.has(operator)) result[operator] = toType(operand);
		else if (LISTS.has(operator)) result[operator] = operand.map(toType);
		else if (operator === "$not") result[operator] = castCondition(schema, path, operand);
		else if (operator === "$elemMatch") result[operator] = normalizeMixed(operand);
		else result[operator] = normalizeMixed(operand);
	}
	return result;
}

export function castFilter(schema, filter) {
	const result = {};
	for (const [key, condition] of Object.entries(filter ?? {})) {
		if (key === "$and" || key === "$or" || key === "$nor") result[key] = condition.map((part) => castFilter(schema, part));
		else if (key.startsWith("$")) result[key] = normalizeMixed(condition);
		else result[key] = castCondition(schema, key, condition);
	}
	return result;
}

// ---- Reading

// Stored JSON has dates as ISO strings; the app works with Date objects.
export function reviveDates(node, value) {
	if (value === null || value === undefined) return value;
	if (node.kind === "leaf") return node.type === "Date" && typeof value === "string" ? new Date(value) : value;
	if (node.kind === "array") return Array.isArray(value) ? value.map((item) => reviveDates(node.of, item)) : value;
	if (typeof value !== "object") return value;
	for (const [key, child] of node.fields) if (key in value) value[key] = reviveDates(child, value[key]);
	return value;
}

// The app wants ObjectId instances where the schema says ObjectId.
export function toOutput(node, value) {
	if (value === null || value === undefined) return value;
	if (node.kind === "leaf") return node.type === "ObjectId" && typeof value === "string" ? new ObjectId(value) : value;
	if (node.kind === "array") return Array.isArray(value) ? value.map((item) => toOutput(node.of, item)) : value;
	if (typeof value !== "object") return value;
	const output = { ...value };
	for (const [key, child] of node.fields) if (key in output) output[key] = toOutput(child, output[key]);
	return output;
}

// Mongoose's select: an inclusion or exclusion object, or a string like "+password".
export function parseSelect(select) {
	if (!select) return { include: null, exclude: null, extra: [] };
	if (typeof select === "string") {
		const extra = [];
		const include = [];
		const exclude = [];
		for (const part of select.split(/\s+/).filter(Boolean)) {
			if (part.startsWith("+")) extra.push(part.slice(1));
			else if (part.startsWith("-")) exclude.push(part.slice(1));
			else include.push(part);
		}
		return { include: include.length ? include : null, exclude: exclude.length ? exclude : null, extra };
	}
	const include = [];
	const exclude = [];
	for (const [path, flag] of Object.entries(select)) (flag ? include : exclude).push(path);
	const onlyIdExcluded = include.length === 0 && exclude.length === 1 && exclude[0] === "_id";
	return { include: include.length ? include : null, exclude: exclude.length ? exclude : null, extra: [], onlyIdExcluded };
}

function copyPath(source, target, path) {
	const segments = path.split(".");
	let from = source;
	let to = target;
	for (let index = 0; index < segments.length - 1; index++) {
		from = from?.[segments[index]];
		if (from === null || from === undefined || typeof from !== "object") return;
		to = to[segments[index]] ??= Array.isArray(from) ? [] : {};
	}
	const last = segments.at(-1);
	if (from[last] !== undefined) to[last] = from[last];
}

export function project(doc, selection, hiddenPaths) {
	const { include, exclude, extra } = selection;
	let result;
	if (include) {
		result = {};
		if (!exclude?.includes("_id")) result._id = doc._id;
		for (const path of include) copyPath(doc, result, path);
	} else {
		result = structuredClone(doc);
		for (const path of exclude ?? []) unsetPath(result, path);
		for (const path of hiddenPaths) if (!extra.includes(path)) unsetPath(result, path);
	}
	if (include) for (const path of extra) copyPath(doc, result, path);
	return result;
}

// What Mongoose does when it loads a document: fields the stored one never had take their schema defaults.
export function applyDefaults(node, doc) {
	if (node.kind !== "object") return doc;
	for (const [key, child] of node.fields) {
		if (child.kind === "object") {
			const nested = applyDefaults(child, doc[key] ?? {});
			if (doc[key] !== undefined || Object.keys(nested).length > 0) doc[key] = nested;
		} else if (doc[key] === undefined) {
			if (child.kind === "array") {
				if (!("default" in child.options && child.options.default === undefined)) doc[key] = [];
			} else if (child.kind === "leaf" && "default" in child.options && child.options.default !== undefined) {
				doc[key] = typeof child.options.default === "function" ? child.options.default() : child.options.default;
			}
		}
	}
	return doc;
}
