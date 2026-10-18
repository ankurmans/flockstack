import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { contactNewsletterInput, contactReference, findContact } from "@/lib/actions/contacts";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterFilterInput, newsletterInput } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import {
	MAX_FIELDS_PER_NEWSLETTER,
	MAX_TEXT_VALUE_LENGTH,
	buildFieldUpdate,
	getFieldKeyProblem,
	listCustomFields,
	slugifyFieldKey,
	toContactUpdate,
	toFieldOutput,
	toFieldValues,
} from "@/lib/custom-fields";
import { MAX_TAG_LENGTH } from "@/lib/tag-rules";
import { addTags, deleteTag, listTagsWithCounts, normalizeTags, removeTags } from "@/lib/tags";
import Contact from "@/models/Contact";
import CustomField, { CUSTOM_FIELD_TYPES } from "@/models/CustomField";

const GROUP = "Tags and fields";
const tagInput = z.string().trim().min(1).max(60).describe(`The tag: letters, digits, spaces and - _ . : / + &, ${MAX_TAG_LENGTH} characters at most. Tags are lowercased, so VIP and vip are one tag.`);
const fieldKeyInput = z.string().trim().min(1).max(30).describe("The field's key, e.g. first_name");

const FieldSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	key: z.string().describe("What merge tags and segments call the field: {{first_name}}"),
	label: z.string(),
	type: z.enum(CUSTOM_FIELD_TYPES).describe("text, number, or date (YYYY-MM-DD)"),
	onSignupForm: z.boolean().describe("The newsletter's own signup form asks for it"),
});
const ContactTagsSchema = z.object({
	id: z.string(),
	email: z.string(),
	tags: z.array(z.string()).describe("The contact's tags after the change"),
	changed: z.boolean().describe("False when the contact already had the tag, or didn't have it to remove"),
});

async function findField(account, newsletterId, key) {
	const field = await CustomField.findOne(scoped(account, { newsletterId, key: key.trim().toLowerCase() })).lean();
	if (!field) throw actionError("not_found", "Custom field not found");
	return field;
}

const listTags = defineAction({
	name: "list_tags",
	tryWithoutPlan: true,
	title: "List tags",
	group: GROUP,
	description: "Lists the tags a newsletter's contacts have had, each with how many contacts have it now. Filter list_contacts or a segment by a tag.",
	http: { method: "GET", path: "/tags" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter.") }),
	output: z.object({ tags: z.array(z.object({ name: z.string(), contacts: z.number().int() })) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		return { tags: await listTagsWithCounts(account, newsletter._id) };
	},
});

const addTag = defineAction({
	name: "add_tag",
	tryWithoutPlan: true,
	title: "Add a tag to a contact",
	group: GROUP,
	description:
		"Gives a contact a tag, which segments can filter by and automations can start from (the tag added trigger). A contact has up to 30 tags and a newsletter up to 200. Adding a tag the contact has changes nothing.",
	http: { method: "POST", path: "/contacts/{id}/tags" },
	idempotent: true,
	rateLimit: { limit: 600, window: "1 h" },
	example: { tag: "vip" },
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput, tag: tagInput }),
	output: ContactTagsSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		const { tags, added } = await addTags(account, contact, [input.tag]);
		return { id: String(contact._id), email: contact.email, tags, changed: added.length > 0 };
	},
});

const removeTag = defineAction({
	name: "remove_tag",
	tryWithoutPlan: true,
	title: "Remove a tag from a contact",
	group: GROUP,
	description: "Takes a tag off a contact. The tag stays on the newsletter's list of tags (delete_tag removes it everywhere).",
	http: { method: "DELETE", path: "/contacts/{id}/tags" },
	idempotent: true,
	rateLimit: { limit: 600, window: "1 h" },
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput, tag: tagInput }),
	output: ContactTagsSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		const { tags, removed } = await removeTags(account, contact, [input.tag]);
		return { id: String(contact._id), email: contact.email, tags, changed: removed.length > 0 };
	},
});

const deleteTagAction = defineAction({
	name: "delete_tag",
	tryWithoutPlan: true,
	title: "Delete a tag",
	group: GROUP,
	description: "Takes a tag off every contact of the newsletter and forgets it. It can't be undone. Segments and automations that name the tag keep working but match nobody.",
	http: { method: "DELETE", path: "/tags" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter."), tag: tagInput }),
	output: z.object({ tag: z.string(), contacts: z.number().int().describe("Contacts that lost the tag") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const [tag] = normalizeTags([input.tag]);
		const { removedFrom, existed } = await deleteTag(account, newsletter._id, tag);
		if (!existed) throw actionError("not_found", "Tag not found");
		return { tag, contacts: removedFrom };
	},
});

const listFields = defineAction({
	name: "list_custom_fields",
	tryWithoutPlan: true,
	title: "List custom fields",
	group: GROUP,
	description: "Lists a newsletter's custom fields: values like a first name, a plan or a renewal date that each contact can have. Merge tags ({{first_name|there}}), segments and automations use them.",
	http: { method: "GET", path: "/custom-fields" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter.") }),
	output: z.object({ fields: z.array(FieldSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		return { fields: (await listCustomFields(account, newsletter._id)).map(toFieldOutput) };
	},
});

const createField = defineAction({
	name: "create_custom_field",
	tryWithoutPlan: true,
	title: "Create a custom field",
	group: GROUP,
	description: `Adds a custom field to a newsletter, up to ${MAX_FIELDS_PER_NEWSLETTER}. Its type is text (${MAX_TEXT_VALUE_LENGTH} characters), number or date (YYYY-MM-DD) and can't change later. Merge tags in campaigns name it by key: {{first_name}}, or {{first_name|there}} to print "there" for contacts without a value.`,
	http: { method: "POST", path: "/custom-fields", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { label: "First name", type: "text" },
	input: z.object({
		newsletter: newsletterInput,
		label: z.string().trim().min(1).max(40).describe("What the dashboard calls it, e.g. First name"),
		key: z.string().trim().max(30).optional().describe("Lowercase letters, digits and underscores, starting with a letter. Default: made from the label (first_name)."),
		type: z.enum(CUSTOM_FIELD_TYPES).describe("text, number or date"),
		onSignupForm: z.boolean().optional().describe("Ask for it on the newsletter's own signup form. Default: false."),
	}),
	output: FieldSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const key = input.key ? input.key.toLowerCase() : slugifyFieldKey(input.label);
		const problem = getFieldKeyProblem(key);
		if (problem) throw actionError("validation_failed", problem);
		if ((await CustomField.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_FIELDS_PER_NEWSLETTER) {
			throw actionError("validation_failed", `A newsletter has up to ${MAX_FIELDS_PER_NEWSLETTER} custom fields`);
		}
		try {
			const field = await CustomField.create({
				accountId: account._id,
				newsletterId: newsletter._id,
				key,
				label: input.label,
				type: input.type,
				onSignupForm: input.onSignupForm === true,
			});
			revalidateArchive();
			return toFieldOutput(field.toObject());
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", `The newsletter already has a field with the key ${key}`);
			throw error;
		}
	},
});

const updateField = defineAction({
	name: "update_custom_field",
	tryWithoutPlan: true,
	title: "Update a custom field",
	group: GROUP,
	description: "Changes a custom field's label, or whether the newsletter's signup form asks for it. Its key and type stay, since merge tags, segments and contacts' values use them.",
	http: { method: "PATCH", path: "/custom-fields/{key}" },
	idempotent: true,
	example: { label: "Given name" },
	input: z.object({
		key: fieldKeyInput,
		newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter."),
		label: z.string().trim().min(1).max(40).optional().describe("What the dashboard calls it"),
		onSignupForm: z.boolean().optional().describe("Ask for it on the newsletter's own signup form"),
	}),
	output: FieldSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const field = await findField(account, newsletter._id, input.key);
		const set = { ...(input.label !== undefined && { label: input.label }), ...(input.onSignupForm !== undefined && { onSignupForm: input.onSignupForm }) };
		if (Object.keys(set).length > 0) await CustomField.updateOne(scoped(account, { _id: field._id }), { $set: set });
		if (input.onSignupForm !== undefined) revalidateArchive();
		return toFieldOutput({ ...field, ...set });
	},
});

const deleteField = defineAction({
	name: "delete_custom_field",
	tryWithoutPlan: true,
	title: "Delete a custom field",
	group: GROUP,
	description: "Deletes a custom field and every contact's value for it. It can't be undone. Merge tags that name it print their fallback, and segments that use it match nobody.",
	http: { method: "DELETE", path: "/custom-fields/{key}" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ key: fieldKeyInput, newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter.") }),
	output: z.object({ key: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const field = await findField(account, newsletter._id, input.key);
		await Contact.updateMany(scoped(account, { newsletterId: newsletter._id, [`fields.${field.key}`]: { $exists: true } }), { $unset: { [`fields.${field.key}`]: 1 } });
		await CustomField.deleteOne(scoped(account, { _id: field._id }));
		revalidateArchive();
		return { key: field.key, deleted: true };
	},
});

const setContactField = defineAction({
	name: "set_contact_field",
	tryWithoutPlan: true,
	title: "Set a contact's custom field",
	group: GROUP,
	description: "Sets one custom field of a contact, or clears it with a null value. The value has to fit the field's type: text, a number, or a date as YYYY-MM-DD.",
	http: { method: "PATCH", path: "/contacts/{id}/fields" },
	idempotent: true,
	rateLimit: { limit: 600, window: "1 h" },
	example: { field: "first_name", value: "Jane" },
	input: z.object({
		id: contactReference,
		newsletter: contactNewsletterInput,
		field: fieldKeyInput,
		value: z.union([z.string().max(MAX_TEXT_VALUE_LENGTH), z.number(), z.null()]).describe("The value, or null to clear it"),
	}),
	output: z.object({
		id: z.string(),
		email: z.string(),
		fields: z.record(z.string(), z.union([z.string(), z.number()])).describe("The contact's custom field values after the change"),
	}),
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		const definitions = await listCustomFields(account, contact.newsletterId);
		const update = buildFieldUpdate(definitions, { [input.field.toLowerCase()]: input.value });
		const after = update.isEmpty
			? contact
			: await Contact.findOneAndUpdate(scoped(account, { _id: contact._id }), toContactUpdate(update), { returnDocument: "after" }).lean();
		return { id: String(contact._id), email: contact.email, fields: toFieldValues(after ?? contact) };
	},
});

export const tagActions = [listTags, addTag, removeTag, deleteTagAction, listFields, createField, updateField, deleteField, setContactField];
