import mongoose from "mongoose";

// Customer data always belongs to one account, and every query on it has to name the account: one
// without accountId throws instead of reading or changing another account's data. Webhooks, jobs and
// public links that find a document by a signed or unique key say so with { crossAccount: true }.
const QUERY_HOOKS = [
	"countDocuments",
	"deleteMany",
	"deleteOne",
	"distinct",
	"find",
	"findOne",
	"findOneAndDelete",
	"findOneAndReplace",
	"findOneAndUpdate",
	"replaceOne",
	"updateMany",
	"updateOne",
];
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

function isAccountId(value) {
	return value instanceof mongoose.Types.ObjectId || (typeof value === "string" && OBJECT_ID_PATTERN.test(value));
}

function assertScoped(modelName, filter, options) {
	if (options?.crossAccount || isAccountId(filter?.accountId)) return;
	throw new Error(`${modelName} query without an accountId`);
}

export function accountScoped(schema) {
	schema.add({
		accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, immutable: true },
	});
	schema.pre(QUERY_HOOKS, function () {
		assertScoped(this.model.modelName, this.getFilter(), this.getOptions());
	});
	schema.pre("aggregate", function () {
		assertScoped(this.model().modelName, this.pipeline()[0]?.$match, this.options);
	});
	schema.pre("bulkWrite", function (operations) {
		for (const operation of operations) {
			const [type, body] = Object.entries(operation)[0];
			if (type !== "insertOne") assertScoped(this.modelName, body?.filter);
		}
	});
}

// An ObjectId either way: aggregation stages don't cast strings.
export function scoped(account, filter = {}) {
	const accountId = account?._id ?? account;
	if (!isAccountId(accountId)) throw new Error("No account to scope the query to");
	return { ...filter, accountId: new mongoose.Types.ObjectId(String(accountId)) };
}
