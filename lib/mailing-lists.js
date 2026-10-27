import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { emitRecordEvent } from "@/lib/record-events";
import Newsletter from "@/models/Newsletter";
import Contact from "@/models/Contact";

export const MAX_MAILING_LISTS = 50;
export const MAX_AUDIENCE_LISTS = 10;
export const activeMailingLists = (newsletter) => (newsletter.mailingLists ?? []).filter((list) => !list.archived);

export function validateListIds(newsletter, ids, existing = []) {
	const unique = [...new Set(ids)];
	const active = new Set([...activeMailingLists(newsletter).map(({ id }) => id), ...existing]);
	if (unique.some((id) => !active.has(id))) throw actionError("validation_failed", "Choose active mailing lists from this newsletter");
	return unique;
}

export async function campaignListChanges(account, newsletterId, input, existing = {}) {
	if (input.listIds === undefined && input.excludeListIds === undefined) return {};
	const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).select({ mailingLists: 1 }).lean();
	if (!newsletter) throw actionError("not_found", "Newsletter not found");
	return Object.fromEntries(["listIds", "excludeListIds"].filter((key) => input[key] !== undefined).map((key) => [key, validateListIds(newsletter, input[key], existing[key] ?? [])]));
}

// Replacing the visible choices preserves archived memberships; an old preference form cannot silently erase them.
export async function setContactLists(account, newsletter, contact, ids, { preserveArchived = false } = {}) {
	const chosen = validateListIds(newsletter, ids, preserveArchived ? [] : contact.listIds ?? []);
	const active = new Set(activeMailingLists(newsletter).map(({ id }) => id));
	const listIds = [...new Set([...chosen, ...(preserveArchived ? (contact.listIds ?? []).filter((id) => !active.has(id)) : [])])];
	const before = contact.listIds ?? [];
	if (before.length === listIds.length && before.every((id) => listIds.includes(id))) return { contactId: String(contact._id), listIds };
	const saved = await Contact.updateOne(scoped(account, { _id: contact._id, newsletterId: newsletter._id, ...(contact.listIds === undefined ? { listIds: { $exists: false } } : { listIds: contact.listIds }) }), { $set: { listIds } });
	if (!saved.matchedCount) throw actionError("conflict", "The mailing list choices changed. Reload and try again.");
	await emitRecordEvent("subscriber.lists_changed", { accountId: account._id, newsletterId: newsletter._id, id: contact._id });
	return { contactId: String(contact._id), listIds };
}
