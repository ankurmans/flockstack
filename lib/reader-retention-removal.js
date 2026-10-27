import "server-only";
import { scoped } from "@/lib/account-scope";
import ReaderRetention from "@/models/ReaderRetention";
import CancellationResponse from "@/models/CancellationResponse";

export async function removeReaderRetentionData(contact) {
	await CancellationResponse.deleteMany(scoped(contact.accountId, { contactId: contact._id }));
	// A provider subscription's once-only offer history survives without a reader profile. Revoking its in-flight lease
	// prevents a response that raced deletion from writing this contact back onto the financial record.
	await ReaderRetention.updateMany(scoped(contact.accountId, { contactId: contact._id }), { $unset: { contactId: 1, lease: 1 }, $inc: { revision: 1 } });
}
