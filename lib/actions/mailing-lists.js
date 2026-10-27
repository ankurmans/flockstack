import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput, newsletterInput } from "@/lib/actions/shared";
import { MAX_MAILING_LISTS, setContactLists } from "@/lib/mailing-lists";
import { emitRecordEvent } from "@/lib/record-events";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import Contact from "@/models/Contact";
const list = z.object({ id: z.string(), name: z.string(), description: z.string(), archived: z.boolean() });
const output = z.object({ revision: z.number().int(), lists: z.array(list) });
const dto = (newsletter) => ({ revision: newsletter.mailingListsRevision ?? 0, lists: newsletter.mailingLists ?? [] });
export const mailingListActions = [
	defineAction({ name: "list_mailing_lists", title: "List mailing lists", group: "Mailing lists", readOnly: true, description: "Optional reader preference lists within one newsletter, including archived lists. General issues still reach all active subscribers unless the campaign chooses listIds or excludeListIds. A list is separate from a subscriber's active or unsubscribed status.", http: { method: "GET", path: "/mailing-lists" }, input: z.object({ newsletter: newsletterInput }), output, handler: async ({ account, input }) => dto(await findNewsletter(account, input.newsletter)) }),
	defineAction({ name: "upsert_mailing_list", title: "Save a mailing list", group: "Mailing lists", idempotent: false, description: "Creates or updates an optional, reader-visible list in this newsletter, up to 50. Archiving hides new choices but preserves memberships and existing campaign targeting. Nobody is enrolled, resubscribed or emailed by this call. A conflicting edit is refused.", http: { method: "POST", path: "/mailing-lists" }, input: z.object({ newsletter: newsletterInput, id: z.string().max(64).optional().describe("Existing list ID; omit to create"), name: z.string().trim().min(1).max(80).describe("Reader-visible name"), description: z.string().trim().max(300).default("").describe("Reader-visible explanation of the emails in this list"), archived: z.boolean().default(false).describe("Hide from new choices, preserving memberships and existing audiences") }), output, handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter); const lists = [...(newsletter.mailingLists ?? [])];
		const index = input.id ? lists.findIndex(({ id }) => id === input.id) : -1;
		if (input.id && index < 0) throw actionError("not_found", "Mailing list not found");
		if (index < 0 && lists.length >= MAX_MAILING_LISTS) throw actionError("conflict", "A newsletter can have 50 mailing lists");
		const previous = lists[index]; const savedList = { id: input.id ?? randomUUID(), name: input.name, description: input.description, archived: input.archived };
		if (index < 0) lists.push(savedList); else lists[index] = savedList;
		const revision = newsletter.mailingListsRevision ?? 0;
		const version = revision ? { mailingListsRevision: revision } : { $or: [{ mailingListsRevision: 0 }, { mailingListsRevision: { $exists: false } }] };
		const saved = await Newsletter.updateOne(scoped(account, { _id: newsletter._id, ...version }), { $set: { mailingLists: lists, mailingListsRevision: revision + 1 } });
		if (!saved.matchedCount) throw actionError("conflict", "The mailing lists changed. Reload and try again.");
		await emitRecordEvent(index < 0 ? "mailing_list.created" : input.archived && !previous.archived ? "mailing_list.archived" : "mailing_list.updated", { accountId: account._id, newsletterId: newsletter._id, id: savedList.id });
		return dto({ mailingLists: lists, mailingListsRevision: revision + 1 });
	} }),
	defineAction({ name: "set_contact_lists", title: "Set a contact's mailing lists", group: "Mailing lists", idempotent: true, description: "Replaces one contact's list memberships with active lists from their newsletter (existing archived memberships may be kept or removed). consent must be true: the contact agreed to these emails. Does not change subscription status, suppression or paid access, and sends no email. Readers can change their own choices through their signed preference link.", http: { method: "PATCH", path: "/contacts/{id}/lists" }, input: z.object({ id: idInput("contact"), listIds: z.array(z.string().min(1).max(64)).max(MAX_MAILING_LISTS).describe("Active list IDs in this contact's newsletter; empty leaves every list"), consent: z.literal(true).describe("The contact agreed to receive emails from these lists") }), output: z.object({ contactId: z.string(), listIds: z.array(z.string()) }), handler: async ({ account, input }) => {
		if (!isObjectIdString(input.id)) throw actionError("not_found", "Contact not found");
		const contact = await Contact.findOne(scoped(account, { _id: input.id })).lean(); if (!contact) throw actionError("not_found", "Contact not found");
		return setContactLists(account, await findNewsletter(account, String(contact.newsletterId)), contact, input.listIds);
	} }),
];
