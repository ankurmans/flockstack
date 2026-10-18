import { ObjectId } from "@/lib/docdb";

// Customer data always belongs to one account, and every query on it has to name the account: one
// without accountId throws instead of reading or changing another account's data. Webhooks, jobs and
// public links that find a document by a signed or unique key say so with { crossAccount: true }.
// The check itself lives in lib/docdb/model.js; this marks a schema as customer data.
export function accountScoped(schema) {
	schema.add({
		accountId: { type: ObjectId, required: true, immutable: true },
	});
	schema.accountScoped = true;
}

// An ObjectId either way: aggregation stages don't cast strings.
export function scoped(account, filter = {}) {
	const accountId = account?._id ?? account;
	if (!ObjectId.isValid(accountId instanceof ObjectId ? accountId : String(accountId))) throw new Error("No account to scope the query to");
	return { ...filter, accountId: new ObjectId(String(accountId)) };
}
