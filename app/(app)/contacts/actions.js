"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function importContacts({ newsletterId, rows, consent, importId, duplicates, tags }) {
	const { output, failure } = await runDashboardAction("import_contacts", {
		newsletter: String(newsletterId ?? ""),
		contacts: Array.isArray(rows) ? rows : [],
		consent: consent === true,
		...(Array.isArray(tags) && tags.length > 0 && { tags: tags.map(String) }),
		...(importId && { importId: String(importId) }),
		...(duplicates && { duplicates }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return output;
}

// With the box ticked, the contact is active at once: no confirmation email, the welcome email if it's on.
export async function addContact(_state, formData) {
	const { output, failure } = await runDashboardAction("add_contact", {
		newsletter: String(formData.get("newsletterId") ?? ""),
		email: String(formData.get("email") ?? ""),
		consent: formData.get("consent") === "on",
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	if (!output.created) return { error: `${output.email} is already a contact` };
	return { email: output.email, status: output.status };
}

export async function setContactStatus(id, status) {
	const { failure } = await runDashboardAction("update_contact_status", { id: String(id), status });
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : { ok: true };
}

// Held signups (lib/signup-approval.js): some contacts, or all of them up to a batch.
export async function approveHeldSignups({ newsletterId, contactIds, all }) {
	const { output, failure } = await runDashboardAction("approve_held_signups", {
		newsletter: String(newsletterId ?? ""),
		...(all ? { all: true } : { contactIds: (contactIds ?? []).map(String) }),
	});
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : output;
}

export async function rejectHeldSignups({ newsletterId, contactIds, all }) {
	const { output, failure } = await runDashboardAction("reject_held_signups", {
		newsletter: String(newsletterId ?? ""),
		...(all ? { all: true } : { contactIds: (contactIds ?? []).map(String) }),
	});
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : output;
}

export async function deleteContact(id) {
	const { failure } = await runDashboardAction("delete_contact", { id: String(id) });
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : { ok: true };
}

// A link to the CSV with the list's filters, valid for an hour.
export async function exportContacts({ newsletterId, status, query, tag } = {}) {
	const { output, failure } = await runDashboardAction("export_contacts", {
		...(newsletterId && { newsletter: String(newsletterId) }),
		...(status && { status }),
		...(query && { search: String(query) }),
		...(tag && { tag: String(tag) }),
	});
	return failure ? toFormError(failure) : { url: output.url, count: output.count };
}

export async function addContactTag(id, tag) {
	const { output, failure } = await runDashboardAction("add_tag", { id: String(id), tag: String(tag ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, tags: output.tags };
}

export async function removeContactTag(id, tag) {
	const { output, failure } = await runDashboardAction("remove_tag", { id: String(id), tag: String(tag ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, tags: output.tags };
}

// An empty value clears the field. A list field with several choices sends an array, a true/false field a boolean.
export async function setContactField(id, field, value) {
	const isEmpty = value === null || value === undefined || (Array.isArray(value) ? value.length === 0 : String(value).trim() === "");
	const { output, failure } = await runDashboardAction("set_contact_field", {
		id: String(id),
		field: String(field ?? ""),
		value: isEmpty ? null : Array.isArray(value) ? value.map(String) : typeof value === "boolean" ? value : String(value),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, fields: output.fields };
}

// A large list loses the tag in the background: the contacts page shows how far it got (getRemovals).
export async function deleteTag(newsletterId, tag) {
	const { output, failure } = await runDashboardAction("delete_tag", { newsletter: String(newsletterId ?? ""), tag: String(tag ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, contacts: output.contacts, inBackground: output.inBackground };
}

export async function createCustomField({ newsletterId, label, type, options, multiple, onSignupForm, readerEditable }) {
	const { output, failure } = await runDashboardAction("create_custom_field", {
		newsletter: String(newsletterId ?? ""),
		label: String(label ?? ""),
		type: String(type ?? ""),
		...(type === "list" && { options: Array.isArray(options) ? options.map(String) : [], multiple: multiple === true }),
		onSignupForm: onSignupForm === true,
		readerEditable: readerEditable === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, field: output };
}

export async function updateCustomField({ newsletterId, key, onSignupForm, readerEditable }) {
	const { failure } = await runDashboardAction("update_custom_field", {
		newsletter: String(newsletterId ?? ""),
		key: String(key ?? ""),
		...(onSignupForm !== undefined && { onSignupForm: onSignupForm === true }),
		...(readerEditable !== undefined && { readerEditable: readerEditable === true }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true };
}

export async function deleteCustomField({ newsletterId, key }) {
	const { output, failure } = await runDashboardAction("delete_custom_field", { newsletter: String(newsletterId ?? ""), key: String(key ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true, contacts: output.contacts, inBackground: output.inBackground };
}

// Tags and fields coming off the newsletter's contacts in the background, for the contacts page to say how far they got.
export async function getRemovals(newsletterId) {
	const { output, failure } = await runDashboardAction("list_removals", { newsletter: String(newsletterId ?? "") });
	return failure ? toFormError(failure) : { removals: output.removals };
}

export async function retryRemoval(id) {
	const { output, failure } = await runDashboardAction("retry_removal", { id: String(id ?? "") });
	return failure ? toFormError(failure) : { removal: output };
}

// The color a tag is drawn in on the contacts page; an empty color goes back to the plain gray.
export async function setTagColor(newsletterId, tag, color) {
	const { failure } = await runDashboardAction("set_tag_color", { newsletter: String(newsletterId ?? ""), tag: String(tag ?? ""), color: color ? String(color) : null });
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return { ok: true };
}

export async function saveContactLists(id, _state, form) {
	const { failure } = await runDashboardAction("set_contact_lists", { id: String(id), listIds: form.getAll("lists").map(String), consent: form.get("consent") === "on" });
	if (failure) return { error: failure.message }; revalidatePath("/contacts"); return { ok: true };
}
