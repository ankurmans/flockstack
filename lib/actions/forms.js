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
import { POPUP_LIMITS, POPUP_PAGES, POPUP_TRIGGERS, getPopupProblem, getPopupSettings } from "@/lib/popup-rules";
import { revalidateArchive } from "@/lib/archive-data";
import { isObjectIdString } from "@/lib/validation";
import { getSignupFlowProblem, MAX_SIGNUP_FLOW_STEPS, SIGNUP_FLOW_TYPES } from "@/lib/signup-flow-rules";
import Survey from "@/models/Survey";
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

const FlowStep = z.object({
	type: z.enum(SIGNUP_FLOW_TYPES).describe("A survey, optional paid-subscription offer, or opt-in recommendations"),
	surveyId: z.string().regex(/^[a-f0-9]{24}$/).optional().describe("An open survey in this newsletter, required for a survey step"),
});

async function assertFlow(account, newsletter, flow) {
	if (flow === undefined) return;
	const problem = getSignupFlowProblem(flow);
	if (problem) throw actionError("validation_failed", problem);
	const surveyId = flow.find((step) => step.type === "survey")?.surveyId;
	if (surveyId && !await Survey.exists(scoped(account, { _id: surveyId, newsletterId: newsletter._id, closed: { $ne: true } }))) throw actionError("validation_failed", "Choose an open survey from this newsletter.");
}

async function setArchiveFlow(account, newsletter, form, enabled) {
	if (enabled === undefined) return newsletter;
	if (enabled) await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { signupFlowFormId: form._id } });
	else await Newsletter.updateOne(scoped(account, { _id: newsletter._id, signupFlowFormId: form._id }), { $unset: { signupFlowFormId: 1 } });
	return Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean();
}

const formShape = {
	archiveDefault: z.boolean().optional().describe("Use this form's steps after the newsletter's built-in archive and popup signups. One form per newsletter can be the default. False only clears this form if it is the current default."),
	flow: z.array(FlowStep).max(MAX_SIGNUP_FLOW_STEPS).optional().describe("Optional ordered steps after signup, before redirectUrl. Up to three, one per kind. Empty keeps the ordinary success/redirect behavior. Survey responses are optional; upsells open the existing plan picker; recommendations require a newly created active subscriber and an explicit choice."),
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
	flow: z.array(FlowStep).optional().describe("Configured signup steps in order, if any"),
	archiveDefault: z.boolean().optional().describe("True when this form supplies the archive and popup signup steps"),
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
		...(form.flow !== undefined && { flow: form.flow }),
		...(String(newsletter.signupFlowFormId) === String(form._id) && { archiveDefault: true }),
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
		externalId: z.string().trim().min(1).max(160).optional().describe("A retry key unique in the account; returns the saved form unchanged on a repeat."),
		...Object.fromEntries(Object.entries(formShape).map(([key, schema]) => [key, schema.optional()])),
		name: formShape.name,
	}),
	output: FormSchema,
	handler: async ({ account, input: { newsletter: reference, ...rest } }) => {
		const newsletter = await findNewsletter(account, reference);
		if (rest.externalId) {
			const existing = await Form.findOne(scoped(account, { externalId: rest.externalId })).lean();
			if (existing) {
				if (String(existing.newsletterId) !== String(newsletter._id)) throw actionError("conflict", "This retry key belongs to another newsletter");
				return toForm(account, existing, newsletter);
			}
		}
		const values = cleanValues(rest);
		const problem = getFormProblem(values);
		if (problem) throw actionError("validation_failed", problem);
		if ((await Form.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_FORMS_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has up to ${MAX_FORMS_PER_NEWSLETTER} forms`);
		}
		await assertFields(account, newsletter._id, values.fields ?? []);
		await assertFlow(account, newsletter, values.flow);
		const form = await Form.create({ ...values, fields: values.fields?.length ? values.fields : undefined, accountId: account._id, newsletterId: newsletter._id });
		return toForm(account, form.toObject(), await setArchiveFlow(account, newsletter, form, values.archiveDefault));
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
		await assertFlow(account, newsletter, cleaned.flow);
		const set = {};
		for (const key of ["name", "buttonText", "successMessage", "redirectUrl"]) if (key in cleaned) set[key] = cleaned[key] ?? "";
		if (cleaned.fields) set.fields = cleaned.fields;
		if (cleaned.flow !== undefined) set.flow = cleaned.flow;
		if (cleaned.colors) for (const key of Object.keys(cleaned.colors)) set[`colors.${key}`] = cleaned.colors[key] ?? "";
		await Form.updateOne(scoped(account, { _id: form._id }), { $set: set });
		return toForm(account, await Form.findOne(scoped(account, { _id: form._id })).lean(), await setArchiveFlow(account, newsletter, form, cleaned.archiveDefault));
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
		await Newsletter.updateOne(scoped(account, { _id: form.newsletterId, signupFlowFormId: form._id }), { $unset: { signupFlowFormId: 1 } });
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

const PopupSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean(),
	trigger: z.enum(POPUP_TRIGGERS).describe("scroll: once the reader is scrollPercent down the page. time: seconds after the page opens. exit: when the mouse leaves through the top of the window, on desktop only"),
	seconds: z.number().int(),
	scrollPercent: z.number().int(),
	frequencyDays: z.number().int().describe("Days a reader who closes the pop-up doesn't see it again, kept in their own browser"),
	pages: z.enum(POPUP_PAGES).describe("issues: issue pages. home: the website's front page. all: those and the author pages"),
	gate: z.object({
		enabled: z.boolean(),
		previewPercent: z.number().int(),
		freeLatest: z.number().int(),
	}),
});

function toPopup(newsletter) {
	return { newsletterId: String(newsletter._id), ...getPopupSettings(newsletter) };
}

const getPopupSettingsAction = defineAction({
	name: "get_popup_settings",
	tryWithoutPlan: true,
	title: "Get pop-up settings",
	group: GROUP,
	description:
		"Gets a newsletter's website pop-up: when it opens, where it shows, how long closing it snoozes it, and the gate. The pop-up never shows to someone who already signed up in that browser, and the snooze is a flag in the reader's own browser storage, never a cookie. The gate shows an issue's beginning only to readers who haven't subscribed, followed by the signup form.",
	http: { method: "GET", path: "/popup" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: PopupSchema,
	handler: async ({ account, input }) => toPopup(await findNewsletter(account, input.newsletter)),
});

const updatePopupSettings = defineAction({
	name: "update_popup_settings",
	tryWithoutPlan: true,
	title: "Update pop-up settings",
	group: GROUP,
	description: `Changes a newsletter's website pop-up. Send only what changes; gate keeps the fields you leave out. trigger scroll opens it once the reader is scrollPercent (${POPUP_LIMITS.scrollPercent.min} to ${POPUP_LIMITS.scrollPercent.max}) down the page, time after seconds (${POPUP_LIMITS.seconds.min} to ${POPUP_LIMITS.seconds.max}), exit when the mouse leaves through the top of the window, on desktop. Closing it snoozes it for frequencyDays in that reader's browser. The gate shows every issue but the newest freeLatest (0 to ${POPUP_LIMITS.freeLatest.max}) as its first previewPercent (${POPUP_LIMITS.previewPercent.min} to ${POPUP_LIMITS.previewPercent.max}) of the text in plain words, then the signup form: subscribers who are signed in to the website read it whole, and the RSS feed carries the same beginning. Paid issues keep their own teaser. Changes show on the website within a moment.`,
	http: { method: "PATCH", path: "/popup" },
	idempotent: true,
	example: { trigger: "time", seconds: 20, frequencyDays: 7 },
	input: z.object({
		newsletter: newsletterInput,
		enabled: z.boolean().optional().describe("Show the pop-up. On unless turned off."),
		trigger: z.enum(POPUP_TRIGGERS).optional().describe("scroll (the default), time or exit"),
		seconds: z.number().int().optional().describe("With trigger time: seconds after the page opens. Default 15."),
		scrollPercent: z.number().int().optional().describe("With trigger scroll: how far down the page. Default 45."),
		frequencyDays: z.number().int().optional().describe("Days a closed pop-up stays away for that reader. Default 14."),
		pages: z.enum(POPUP_PAGES).optional().describe("issues (the default), home or all"),
		gate: z
			.object({
				enabled: z.boolean().optional().describe("Show only the beginning of issues to readers who haven't subscribed. Off by default."),
				previewPercent: z.number().int().optional().describe("The share of the text they see, in percent. Default 30."),
				freeLatest: z.number().int().optional().describe("How many of the newest issues stay open to everyone. Default 1."),
			})
			.optional()
			.describe("The gate"),
	}),
	output: PopupSchema,
	handler: async ({ account, input: { newsletter: reference, gate, ...changes } }) => {
		const newsletter = await findNewsletter(account, reference);
		const current = getPopupSettings(newsletter);
		const merged = { ...current, ...changes, gate: { ...current.gate, ...gate } };
		const problem = getPopupProblem(merged);
		if (problem) throw actionError("validation_failed", problem);
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { popup: merged } });
		revalidateArchive();
		return toPopup({ ...newsletter, popup: merged });
	},
});

export const formActions = [listForms, getForm, createForm, updateForm, deleteForm, getPopupSettingsAction, updatePopupSettings, getMagicLink, rotateMagicLink];
