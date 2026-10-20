import { scoped } from "@/lib/account-scope";
import { listCustomFields, parseFieldValue } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";
import { verifySubscriberToken } from "@/lib/subscriber-links";
import Contact from "@/models/Contact";

// The preference center: a page on the newsletter's host, opened from the link in an email's footer or {{preferences_url}}
// (lib/subscriber-links.js). A reader changes the custom fields the owner marked readerEditable (a name, a frequency, the
// topics they want) and can unsubscribe; nothing else of the contact is theirs to set.
const READER_STATUSES = ["active", "pending", "dormant"];

// { newsletter, contact, fields } for a link that is good and whose contact is still subscribed, else null.
export async function openPreferences(token) {
	const reference = verifySubscriberToken("preferences", token);
	if (!reference) return null;
	await connectDb();
	const newsletter = await findNewsletterAnywhere({ _id: reference.newsletterId });
	if (!newsletter) return null;
	const account = { _id: newsletter.accountId };
	const contact = await Contact.findOne(scoped(account, { _id: reference.contactId, newsletterId: newsletter._id })).lean();
	if (!contact || !READER_STATUSES.includes(contact.status)) return null;
	const fields = (await listCustomFields(account, newsletter._id)).filter((field) => field.readerEditable);
	return { newsletter, contact, fields, reference };
}

// What a reader sent for the editable fields -> a contact update, or { problem }. read(field): the form's value for it
// (several for a multiple list). A blank clears a field. Fields the owner didn't mark editable are never read.
export async function savePreferences(token, read) {
	const open = await openPreferences(token);
	if (!open) return { problem: "invalid" };
	const set = {};
	const unset = {};
	for (const field of open.fields) {
		const input = read(field);
		const values = (Array.isArray(input) ? input : [input]).map((item) => String(item ?? "").trim()).filter(Boolean);
		const parsed = values.length === 0 ? { value: null } : parseFieldValue(field.type, field.type === "list" && field.multiple ? values : values[0], field);
		if (parsed.problem) return { problem: `${field.label} ${parsed.problem}` };
		if (parsed.value === null) unset[`fields.${field.key}`] = 1;
		else set[`fields.${field.key}`] = parsed.value;
	}
	const update = { ...(Object.keys(set).length > 0 && { $set: set }), ...(Object.keys(unset).length > 0 && { $unset: unset }) };
	if (Object.keys(update).length > 0) await Contact.updateOne(scoped({ _id: open.newsletter.accountId }, { _id: open.contact._id }), update);
	return { ok: true };
}
