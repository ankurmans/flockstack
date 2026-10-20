import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { listCustomFields } from "@/lib/custom-fields";
import {
	MAX_BUTTON_TEXT,
	MAX_FORMS_PER_NEWSLETTER,
	MAX_FORM_FIELDS,
	MAX_SUCCESS_MESSAGE,
	getFormProblem,
} from "@/lib/form-rules";
import { getEmbedCodes, getFormDays, toConversion } from "@/lib/forms";
import { MAGIC_EMAIL_TAG, MAGIC_PER_EMAIL, MAGIC_PER_IP, getMagicKeyId, getMagicTemplate } from "@/lib/magic-links";
import { isObjectIdString } from "@/lib/validation";
import Form from "@/models/Form";
import FormDay from "@/models/FormDay";
import Newsletter from "@/models/Newsletter";

const GROUP = "Forms";
const formId = idInput("form");
const MAX_STATS_DAYS = 365;

const colorInput = z.string().trim().toLowerCase().max(7);
const ColorsInput = z
	.object({
		button: colorInput.optional().describe("The button's background, #rrggbb. Empty: the newsletter's accent color."),
		buttonText: colorInput.optional().describe("The button's text, #rrggbb. Empty: black or white, whichever reads better on the button."),
		background: colorInput.optional().describe("The form's background, #rrggbb. Empty: transparent, so it takes the page's."),
		text: colorInput.optional().describe("The text and field borders, #rrggbb. Empty: near-black."),
	})
	.describe("Colors as #rrggbb; empty ones use the defaults");

const formShape = {
	name: z.string().trim().min(1).max(80).describe("What you call the form, in the dashboard and in reports. Visitors don't see it."),
	buttonText: z.string().trim().max(MAX_BUTTON_TEXT).describe("The button's words. Empty: Subscribe."),
	fields: z
		.array(z.string().trim().toLowerCase().max(30))
		.max(MAX_FORM_FIELDS)
		.describe(`Keys of the newsletter's custom fields to ask after the email, ${MAX_FORM_FIELDS} at most: a first name is a custom field`),
	colors: ColorsInput,
	successMessage: z.string().trim().max(MAX_SUCCESS_MESSAGE).describe("What a visitor reads once they are in. Empty: the usual words. A signup that waits for confirmation always says to check the inbox."),
	redirectUrl: z.string().trim().max(500).describe("An https:// page to send visitors to after a signup instead of showing the message. Empty: show the message."),
};

const EmbedSchema = z.object({
	url: z.string().describe("The hosted form, on the newsletter's own host: link to it, or frame it"),
	script: z.string().describe("One line for any page: renders the form in a frame that resizes itself"),
	iframe: z.string().describe("A plain frame for sites that don't allow scripts; it doesn't resize"),
	html: z.string().describe("A plain HTML form that posts to the form's address, with no script and no frame"),
});

const FormSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	buttonText: z.string(),
	fields: z.array(z.string()),
	colors: z.object({ button: z.string(), buttonText: z.string(), background: z.string(), text: z.string() }).describe("What was saved; empty means the default"),
	successMessage: z.string(),
	redirectUrl: z.string(),
	views: z.number().int().describe("Times its page loaded in a browser, crawlers left out"),
	signups: z.number().int().describe("New contacts it brought in, pending ones included"),
	conversion: z.number().nullable().describe("signups over views, 0 to 1; null before the first view"),
	embed: EmbedSchema,
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

async function toForm(account, form, newsletter) {
	const keys = form.fields ?? [];
	const definitions = keys.length > 0 ? await listCustomFields(account, newsletter._id) : [];
	const asked = keys.map((key) => definitions.find((field) => field.key === key)).filter(Boolean);
	const views = form.views ?? 0;
	const signups = form.signups ?? 0;
	return {
		id: String(form._id),
		newsletterId: String(form.newsletterId),
		name: form.name,
		buttonText: form.buttonText ?? "",
		fields: keys,
		colors: { button: form.colors?.button ?? "", buttonText: form.colors?.buttonText ?? "", background: form.colors?.background ?? "", text: form.colors?.text ?? "" },
		successMessage: form.successMessage ?? "",
		redirectUrl: form.redirectUrl ?? "",
		views,
		signups,
		conversion: toConversion(signups, views),
		embed: getEmbedCodes(newsletter, form, asked),
		createdAt: toIso(form.createdAt),
		updatedAt: toIso(form.updatedAt),
	};
}

async function findForm(account, id) {
	const value = String(id ?? "").trim().toLowerCase();
	const form = isObjectIdString(value) ? await Form.findOne(scoped(account, { _id: value })).lean() : null;
	if (!form) throw actionError("not_found", "Form not found");
	const newsletter = await Newsletter.findOne(scoped(account, { _id: form.newsletterId })).lean();
	return { form, newsletter };
}

// The custom fields a form asks for have to be the newsletter's.
async function assertFields(account, newsletterId, keys) {
	if (keys.length === 0) return;
	const known = new Set((await listCustomFields(account, newsletterId)).map((field) => field.key));
	const missing = keys.find((key) => !known.has(key));
	if (missing) throw actionError("validation_failed", `fields: the newsletter has no custom field ${missing}`);
}

function cleanValues(values) {
	return {
		...values,
		fields: values.fields ? [...new Set(values.fields)] : values.fields,
		colors: values.colors && Object.fromEntries(Object.entries(values.colors).map(([key, color]) => [key, color || undefined])),
	};
}

const listForms = defineAction({
	name: "list_forms",
	tryWithoutPlan: true,
	title: "List signup forms",
	group: GROUP,
	description:
		"Lists the signup forms of a newsletter, newest first, with their views, signups and conversion and the code to put each on another site. A form is a page on the newsletter's own host that other sites show in a frame (a one-line script does it and keeps the frame's height), or a plain HTML form that posts to it.",
	http: { method: "GET", path: "/forms" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({ forms: z.array(FormSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const forms = await Form.find(scoped(account, { newsletterId: newsletter._id })).sort({ createdAt: -1, _id: -1 }).lean();
		return { forms: await Promise.all(forms.map((form) => toForm(account, form, newsletter))) };
	},
});

const getForm = defineAction({
	name: "get_form",
	tryWithoutPlan: true,
	title: "Get a signup form",
	group: GROUP,
	description:
		"Gets a form with its embed code and its views and signups for each of the last days (30 by default, up to 365; days are UTC). Views are counted on the server when the form's page loads, once per visitor and moment, with crawlers left out.",
	http: { method: "GET", path: "/forms/{id}" },
	readOnly: true,
	input: z.object({ id: formId, days: z.number().int().min(1).max(MAX_STATS_DAYS).optional().describe("Days of history, 30 by default") }),
	output: FormSchema.extend({ days: z.array(z.object({ date: z.string(), views: z.number().int(), signups: z.number().int() })) }),
	handler: async ({ account, input }) => {
		const { form, newsletter } = await findForm(account, input.id);
		return { ...(await toForm(account, form, newsletter)), days: await getFormDays(account, form, input.days ?? 30) };
	},
});

const createForm = defineAction({
	name: "create_form",
	tryWithoutPlan: true,
	title: "Create a signup form",
	group: GROUP,
	description: `Creates a signup form for other sites: an email field, optional custom fields, a button, colors and what happens after a signup. Up to ${MAX_FORMS_PER_NEWSLETTER} forms a newsletter. Signups through it get the source form:<id>, count toward the form's stats and follow the newsletter's rules: confirmed opt-in, suppression, the honeypot and the limit of 5 signups per visitor in 10 minutes.`,
	http: { method: "POST", path: "/forms", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { name: "Homepage", buttonText: "Join free", successMessage: "Welcome aboard." },
	input: z.object({
		newsletter: newsletterInput,
		...Object.fromEntries(Object.entries(formShape).map(([key, schema]) => [key, schema.optional()])),
		name: formShape.name,
	}),
	output: FormSchema,
	handler: async ({ account, input: { newsletter: reference, ...rest } }) => {
		const newsletter = await findNewsletter(account, reference);
		const values = cleanValues(rest);
		const problem = getFormProblem(values);
		if (problem) throw actionError("validation_failed", problem);
		if ((await Form.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_FORMS_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has up to ${MAX_FORMS_PER_NEWSLETTER} forms`);
		}
		await assertFields(account, newsletter._id, values.fields ?? []);
		const form = await Form.create({ ...values, fields: values.fields?.length ? values.fields : undefined, accountId: account._id, newsletterId: newsletter._id });
		return toForm(account, form.toObject(), newsletter);
	},
});

const updateForm = defineAction({
	name: "update_form",
	tryWithoutPlan: true,
	title: "Update a signup form",
	group: GROUP,
	description: "Changes a form. Send only what changes; colors keeps the colors you leave out, and fields replaces the whole list. Forms already on other sites pick the change up at once.",
	http: { method: "PATCH", path: "/forms/{id}" },
	idempotent: true,
	example: { buttonText: "Join free" },
	input: z.object({ id: formId, ...Object.fromEntries(Object.entries(formShape).map(([key, schema]) => [key, schema.optional()])) }),
	output: FormSchema,
	handler: async ({ account, input: { id, ...changes } }) => {
		const { form, newsletter } = await findForm(account, id);
		const cleaned = cleanValues(changes);
		const merged = { ...form, ...cleaned, colors: { ...form.colors, ...cleaned.colors } };
		const problem = getFormProblem(merged);
		if (problem) throw actionError("validation_failed", problem);
		if (cleaned.fields) await assertFields(account, newsletter._id, cleaned.fields);
		const set = {};
		for (const key of ["name", "buttonText", "successMessage", "redirectUrl"]) if (key in cleaned) set[key] = cleaned[key] ?? "";
		if (cleaned.fields) set.fields = cleaned.fields;
		if (cleaned.colors) for (const key of Object.keys(cleaned.colors)) set[`colors.${key}`] = cleaned.colors[key] ?? "";
		await Form.updateOne(scoped(account, { _id: form._id }), { $set: set });
		return toForm(account, await Form.findOne(scoped(account, { _id: form._id })).lean(), newsletter);
	},
});

const deleteForm = defineAction({
	name: "delete_form",
	tryWithoutPlan: true,
	title: "Delete a signup form",
	group: GROUP,
	description: "Deletes a form and its daily counts. Copies of it on other sites stop working: the page answers not found and a post to its address is refused. Contacts it brought in keep their source, form:<id>.",
	http: { method: "DELETE", path: "/forms/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: formId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const { form } = await findForm(account, input.id);
		await FormDay.deleteMany(scoped(account, { formId: form._id }));
		await Form.deleteOne(scoped(account, { _id: form._id }));
		return { id: String(form._id), deleted: true };
	},
});

const MagicLinkSchema = z.object({
	newsletterId: z.string(),
	template: z
		.string()
		.describe(`The Magic Link: give it to another newsletter or an automation and put its merge tag for the reader's email address where ${MAGIC_EMAIL_TAG} stands`),
	emailTag: z.string().describe("The part of the template to replace with the other platform's merge tag"),
	keyId: z.number().int().describe("Starts at 1. rotate_magic_link moves it up, and links with an earlier key id stop working"),
	requiresConfirmation: z.boolean().describe("The newsletter confirms new signups: a reader the link subscribes gets the confirmation email and joins when they click it"),
	warning: z.string().nullable().describe("Why the link is riskier than it should be, when it is"),
});

function toMagicLink(newsletter) {
	const requiresConfirmation = Boolean(newsletter.requireConfirmation);
	return {
		newsletterId: String(newsletter._id),
		template: getMagicTemplate(newsletter),
		emailTag: MAGIC_EMAIL_TAG,
		keyId: getMagicKeyId(newsletter),
		requiresConfirmation,
		warning: requiresConfirmation
			? null
			: "Confirmed opt-in is off, so anyone who has this link can subscribe any address by typing it in. Turn confirmed opt-in on before you share it.",
	};
}

const getMagicLink = defineAction({
	name: "get_magic_link",
	tryWithoutPlan: true,
	title: "Get the Magic Link",
	group: GROUP,
	description: `Gets a newsletter's Magic Link: one address for readers of another newsletter or an automation, where ${MAGIC_EMAIL_TAG} stands for the platform's merge tag for the reader's email address. Opening it subscribes that address in one click, and with confirmed opt-in on the address still gets the confirmation email and joins when it clicks. The link is signed for the newsletter, not for an address, so anyone who has it can try any address: each address is limited to ${MAGIC_PER_EMAIL.limit} tries a day and each network to ${MAGIC_PER_IP.limit} in 10 minutes.`,
	http: { method: "GET", path: "/newsletters/{id}/magic-link" },
	readOnly: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
	output: MagicLinkSchema,
	handler: async ({ account, input }) => toMagicLink(await findNewsletter(account, input.id)),
});

const rotateMagicLink = defineAction({
	name: "rotate_magic_link",
	tryWithoutPlan: true,
	title: "Retire the Magic Link",
	group: GROUP,
	description: "Moves the newsletter's Magic Link to its next key id: the old link stops working, wherever it was shared, and the answer has the new one. Use it when the link was shared somewhere it shouldn't have been, or is being used to sign up addresses that didn't ask.",
	http: { method: "POST", path: "/newsletters/{id}/magic-link/rotate" },
	destructive: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
	output: MagicLinkSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const magicKeyId = getMagicKeyId(newsletter) + 1;
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { magicKeyId } });
		return toMagicLink({ ...newsletter, magicKeyId });
	},
});

export const formActions = [listForms, getForm, createForm, updateForm, deleteForm, getMagicLink, rotateMagicLink];
