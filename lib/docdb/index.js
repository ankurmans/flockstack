import { getDriver } from "./driver.js";
import { model, models, rawCollection } from "./model.js";
import { ObjectId } from "./object-id.js";
import { CastError, Schema, ValidationError } from "./schema.js";

// The slice of Mongoose this app uses, so models and queries read the way they always did while the documents sit in
// D1 (or SQLite locally). See lib/docdb/model.js for what a query supports.

export const Types = { ObjectId };

export function isValidObjectId(value) {
	return ObjectId.isValid(value);
}

const connection = {
	db: { collection: rawCollection },
	get readyState() {
		return 1;
	},
};

export async function connect() {
	await getDriver();
	return mongoose;
}

export async function disconnect() {
	const driver = await getDriver().catch(() => null);
	driver?.close?.();
}

const mongoose = { Schema, Types, model, models, connection, connect, disconnect, isValidObjectId };

export { CastError, ObjectId, Schema, ValidationError, model, models, rawCollection };
export default mongoose;
