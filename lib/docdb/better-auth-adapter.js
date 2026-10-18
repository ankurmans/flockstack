import { createAdapterFactory } from "better-auth/adapters";
import { ObjectId } from "./object-id.js";
import { rawCollection } from "./model.js";

// Better Auth's database adapter for the document layer, modelled on its MongoDB adapter: the same where-clause
// translation and id handling, over lib/docdb collections instead of a Mongo driver.

class AdapterError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "DocdbAdapterError";
	}
}

function escapeForRegex(input, maxLength = 256) {
	if (typeof input !== "string") return "";
	return input.slice(0, maxLength).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const insensitive = (field, source) => ({ [field]: { $regex: source, $options: "i" } });

function idFromAny(value) {
	if (value instanceof ObjectId) return value.toHexString();
	return value;
}

export function docdbAdapter() {
	let lazyAdapter = null;
	let lazyOptions = null;
	const created = new Set();

	const createCustomAdapter = ({ getFieldAttributes, getFieldName, schema, options }) => {
		const customIdGen = options.advanced?.database?.generateId;
		const hasCustomGenerator = typeof customIdGen === "function";

		async function ensureModelIndexes(model, modelKey) {
			const table = schema[modelKey];
			if (!table || created.has(model)) return;
			created.add(model);
			const collection = rawCollection(model);
			for (const [name, field] of Object.entries(table.fields ?? {})) {
				if (!field?.unique) continue;
				const physical = getFieldName({ model: modelKey, field: name });
				await collection.createIndex({ [physical === "id" ? "_id" : physical]: 1 }, { unique: true, plain: true });
			}
		}

		function serializeID({ field, value, model }) {
			if (hasCustomGenerator) return value;
			if (field === "id" || field === "_id" || schema[model].fields[field]?.references?.field === "id") {
				if (value === null || value === undefined) return value;
				if (Array.isArray(value)) return value.map(idFromAny);
				return idFromAny(value);
			}
			return value;
		}

		function convertWhereClause({ where, modelKey }) {
			if (!where.length) return {};
			const conditions = where.map((w) => {
				const { field: fieldInput, value, operator = "eq", connector = "AND", mode = "sensitive" } = w;
				let field = getFieldName({ model: modelKey, field: fieldInput });
				if (field === "id") field = "_id";
				const attributes = getFieldAttributes({ model: modelKey, field: fieldInput });
				const isInsensitive =
					!(field === "_id" || attributes?.references?.field === "id") &&
					mode === "insensitive" &&
					(typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string")));
				const id = (item) => serializeID({ field, value: item, model: modelKey });
				let condition;
				switch (operator.toLowerCase()) {
					case "eq":
						condition = isInsensitive && typeof value === "string" ? insensitive(field, `^${escapeForRegex(value)}$`) : { [field]: id(value) };
						break;
					case "in": {
						const list = Array.isArray(value) ? value : [value];
						condition = isInsensitive ? { $or: list.map((item) => insensitive(field, `^${escapeForRegex(item)}$`)) } : { [field]: { $in: list.map(id) } };
						break;
					}
					case "not_in": {
						const list = Array.isArray(value) ? value : [value];
						condition = isInsensitive ? { $nor: list.map((item) => insensitive(field, `^${escapeForRegex(item)}$`)) } : { [field]: { $nin: list.map(id) } };
						break;
					}
					case "gt":
					case "gte":
					case "lt":
					case "lte":
						condition = { [field]: { [`$${operator.toLowerCase()}`]: id(value) } };
						break;
					case "ne":
						condition = isInsensitive && typeof value === "string" ? { [field]: { $not: { $regex: `^${escapeForRegex(value)}$`, $options: "i" } } } : { [field]: { $ne: id(value) } };
						break;
					case "contains":
						condition = { [field]: { $regex: `.*${escapeForRegex(value)}.*`, ...(isInsensitive && { $options: "i" }) } };
						break;
					case "starts_with":
						condition = { [field]: { $regex: `^${escapeForRegex(value)}`, ...(isInsensitive && { $options: "i" }) } };
						break;
					case "ends_with":
						condition = { [field]: { $regex: `${escapeForRegex(value)}$`, ...(isInsensitive && { $options: "i" }) } };
						break;
					default:
						throw new AdapterError("UNSUPPORTED_OPERATOR", `Unsupported operator: ${operator}`);
				}
				return { condition, connector };
			});
			if (conditions.length === 1) return conditions[0].condition;
			const and = conditions.filter((item) => item.connector === "AND").map((item) => item.condition);
			const or = conditions.filter((item) => item.connector === "OR").map((item) => item.condition);
			return { ...(and.length && { $and: and }), ...(or.length && { $or: or }) };
		}

		function noJoins(join) {
			if (join) throw new AdapterError("UNSUPPORTED_JOIN", "Joins are not supported by the document adapter");
		}

		function projection(select, modelKey) {
			if (!select?.length) return undefined;
			return Object.fromEntries(select.map((field) => [getFieldName({ field, model: modelKey }), 1]));
		}

		return {
			async create({ model, modelKey = model, data: values }) {
				await ensureModelIndexes(model, modelKey);
				const { insertedId } = await rawCollection(model).insertOne(values);
				return { _id: String(insertedId), ...values };
			},
			async findOne({ model, modelKey = model, where, select, join }) {
				noJoins(join);
				return (await rawCollection(model).findOne(where ? convertWhereClause({ where, modelKey }) : {}, { projection: projection(select, modelKey) })) ?? null;
			},
			async findMany({ model, modelKey = model, where, limit, select, offset, sortBy, join }) {
				noJoins(join);
				const query = rawCollection(model).find(where ? convertWhereClause({ where, modelKey }) : {}, { projection: projection(select, modelKey) });
				if (sortBy) query.sort({ [getFieldName({ field: sortBy.field, model: modelKey })]: sortBy.direction === "desc" ? -1 : 1 });
				if (offset) query.skip(offset);
				if (limit) query.limit(limit);
				return query.toArray();
			},
			async count({ model, modelKey = model, where }) {
				return rawCollection(model).countDocuments(where ? convertWhereClause({ where, modelKey }) : {});
			},
			async update({ model, modelKey = model, where, update: values }) {
				await ensureModelIndexes(model, modelKey);
				const result = await rawCollection(model).findOneAndUpdate(convertWhereClause({ where, modelKey }), { $set: values }, { returnDocument: "after", includeResultMetadata: true });
				return result?.value ?? null;
			},
			async updateMany({ model, modelKey = model, where, update: values }) {
				await ensureModelIndexes(model, modelKey);
				return (await rawCollection(model).updateMany(convertWhereClause({ where, modelKey }), { $set: values })).modifiedCount;
			},
			async delete({ model, modelKey = model, where }) {
				await rawCollection(model).deleteOne(convertWhereClause({ where, modelKey }));
			},
			async deleteMany({ model, modelKey = model, where }) {
				return (await rawCollection(model).deleteMany(convertWhereClause({ where, modelKey }))).deletedCount;
			},
			async consumeOne({ model, modelKey = model, where }) {
				const clause = convertWhereClause({ where, modelKey });
				const doc = await rawCollection(model).findOne(clause);
				if (!doc) return null;
				const { deletedCount } = await rawCollection(model).deleteOne({ _id: doc._id });
				return deletedCount > 0 ? doc : null;
			},
			async incrementOne({ model, modelKey = model, where, increment, set }) {
				await ensureModelIndexes(model, modelKey);
				const clause = convertWhereClause({ where, modelKey });
				const update = {};
				if (Object.keys(increment).length > 0) update.$inc = increment;
				if (set && Object.keys(set).length > 0) update.$set = set;
				if (!update.$inc && !update.$set) return rawCollection(model).findOne(clause);
				const result = await rawCollection(model).findOneAndUpdate(clause, update, { returnDocument: "after", includeResultMetadata: true });
				return result?.value ?? null;
			},
		};
	};

	const adapterOptions = {
		config: {
			adapterId: "docdb-adapter",
			adapterName: "FlockStack document adapter",
			usePlural: false,
			debugLogs: false,
			mapKeysTransformInput: { id: "_id" },
			mapKeysTransformOutput: { _id: "id" },
			supportsArrays: true,
			supportsNumericIds: false,
			// D1 has no interactive transactions: each Better Auth write is one atomic statement.
			transaction: false,
			customTransformInput({ action, data, field, fieldAttributes, options }) {
				if (field === "_id" || fieldAttributes.references?.field === "id") {
					if (typeof options.advanced?.database?.generateId === "function") return data;
					if (action !== "create" && action !== "update") return data;
					if (data instanceof ObjectId) return data.toHexString();
					if (Array.isArray(data)) return data.map(idFromAny);
					if (typeof data === "string") return ObjectId.isValid(data) ? data.toLowerCase() : data;
					if (fieldAttributes?.references?.field === "id" && !fieldAttributes?.required && data === null) return null;
					if (action === "update") return data;
					return new ObjectId().toHexString();
				}
				return data;
			},
			customTransformOutput({ data, field, fieldAttributes }) {
				if (field === "id" || fieldAttributes.references?.field === "id") {
					if (data instanceof ObjectId) return data.toHexString();
					if (Array.isArray(data)) return data.map(idFromAny);
					return data;
				}
				return data;
			},
			customIdGenerator() {
				return new ObjectId().toHexString();
			},
		},
		adapter: createCustomAdapter,
	};
	lazyAdapter = createAdapterFactory(adapterOptions);
	return (options) => {
		lazyOptions = options;
		return lazyAdapter(options);
	};
}
