import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { cleanRichHtml } from "@/lib/clean-html";
import { hasContent } from "@/lib/render-email";
import { textToRich } from "@/lib/rich-text";
import { MAX_SNIPPETS_PER_NEWSLETTER, MAX_SNIPPET_LENGTH, MAX_TEMPLATES_PER_NEWSLETTER } from "@/lib/templates";
import { MAX_BODY_BYTES, isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import IssueTemplate from "@/models/IssueTemplate";
import Snippet from "@/models/Snippet";

const TEMPLATES = "Templates";
const SNIPPETS = "Snippets";
const FORMATS = ["markdown", "rich", "html"];
const nameInput = z.string().trim().min(1).max(100).describe("Its name in the lists, 100 characters at most");

const TemplateSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	subject: z.string(),
	previewText: z.string(),
	format: z.enum(FORMATS).describe("markdown, rich (what the dashboard editor writes) or html (a complete email), as in create_campaign"),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const TemplateDetailSchema = TemplateSchema.extend({ content: z.string().describe("The body in its format") });
const SnippetSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	content: z.string().describe("The snippet as HTML, as it is inserted into an issue"),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

function toTemplate(template) {
	return {
		id: String(template._id),
		newsletterId: String(template.newsletterId),
		name: template.name,
		subject: template.subject ?? "",
		previewText: template.previewText ?? "",
		format: template.format ?? "rich",
		createdAt: toIso(template.createdAt),
		updatedAt: toIso(template.updatedAt),
	};
}

export function getTemplateContent(template) {
	return (template.format === "markdown" ? template.markdown : template.html) ?? "";
}

function toSnippet(snippet) {
	return {
		id: String(snippet._id),
		newsletterId: String(snippet.newsletterId),
		name: snippet.name,
		content: snippet.html,
		createdAt: toIso(snippet.createdAt),
		updatedAt: toIso(snippet.updatedAt),
	};
}

export async function findTemplate(account, id) {
	const template = isObjectIdString(id) ? await IssueTemplate.findOne(scoped(account, { _id: id })).lean() : null;
	if (!template) throw actionError("not_found", "Template not found");
	return template;
}

async function findSnippet(account, id) {
	const snippet = isObjectIdString(id) ? await Snippet.findOne(scoped(account, { _id: id })).lean() : null;
	if (!snippet) throw actionError("not_found", "Snippet not found");
	return snippet;
}

function readBody(format, content) {
	if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
		throw actionError("validation_failed", `The content is over ${MAX_BODY_BYTES / 1000} KB`);
	}
	return { format, [format === "markdown" ? "markdown" : "html"]: content };
}

async function countIn(Model, account, newsletterId) {
	return Model.countDocuments(scoped(account, { newsletterId }));
}

const listTemplates = defineAction({
	name: "list_templates",
	tryWithoutPlan: true,
	title: "List templates",
	group: TEMPLATES,
	description: `Lists the account's saved issue templates by name, without their content (get_template has it). A template is an issue to start new ones from: create_campaign takes one with template.`,
	http: { method: "GET", path: "/templates" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ templates: z.array(TemplateSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const templates = await IssueTemplate.find(scoped(account, newsletter ? { newsletterId: newsletter._id } : {}))
			.select({ markdown: 0, html: 0 })
			.sort({ name: 1, _id: 1 })
			.lean();
		return { templates: templates.map(toTemplate) };
	},
});

const getTemplate = defineAction({
	name: "get_template",
	tryWithoutPlan: true,
	title: "Get a template",
	group: TEMPLATES,
	description: "Gets a saved issue template with its subject, preview text and content.",
	http: { method: "GET", path: "/templates/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("template") }),
	output: TemplateDetailSchema,
	handler: async ({ account, input }) => {
		const template = await findTemplate(account, input.id);
		return { ...toTemplate(template), content: getTemplateContent(template) };
	},
});

const createTemplate = defineAction({
	name: "create_template",
	tryWithoutPlan: true,
	title: "Create a template",
	group: TEMPLATES,
	description: `Saves an issue template, ${MAX_TEMPLATES_PER_NEWSLETTER} at most for each newsletter. Pass campaign to save an existing campaign (a draft or a sent issue) as it is: its subject, preview text and content, in its newsletter. Or pass content with its format to write one; with neither the template is empty. create_campaign starts a new draft from it with template.`,
	http: { method: "POST", path: "/templates", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { name: "Weekly letter", campaign: "6650f1c2e9b1d4a012345678" },
	input: z.object({
		newsletter: newsletterInput,
		name: nameInput,
		campaign: z.string().trim().max(100).optional().describe("A campaign's ID to save as a template. The newsletter is the campaign's."),
		subject: z.string().trim().max(200).optional().describe("Its subject line. Default: the campaign's."),
		previewText: z.string().trim().max(300).optional().describe("Its preview text. Default: the campaign's."),
		format: z.enum(FORMATS).optional().describe("The format of content: markdown (the default), rich or html"),
		content: z.string().max(MAX_BODY_BYTES).optional().describe("Its body in that format, 500 KB at most. Default: the campaign's."),
	}),
	output: TemplateDetailSchema,
	handler: async ({ account, input }) => {
		let source = null;
		if (input.campaign !== undefined) {
			source = isObjectIdString(input.campaign) ? await Campaign.findOne(scoped(account, { _id: input.campaign })).lean() : null;
			if (!source || source.status === "canceled") throw actionError("not_found", "Campaign not found");
		}
		const newsletter = source ? { _id: source.newsletterId } : await findNewsletter(account, input.newsletter, { _id: 1 });
		if (source && input.newsletter) {
			const named = await findNewsletter(account, input.newsletter, { _id: 1 });
			if (String(named._id) !== String(source.newsletterId)) throw actionError("validation_failed", "newsletter: the campaign belongs to another newsletter");
		}
		if ((await countIn(IssueTemplate, account, newsletter._id)) >= MAX_TEMPLATES_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has ${MAX_TEMPLATES_PER_NEWSLETTER} templates at most`);
		}
		const content = input.content !== undefined ? readBody(input.format ?? "markdown", input.content) : source ? { format: source.format, markdown: source.markdown, html: source.html } : { format: input.format ?? "rich" };
		const template = await IssueTemplate.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			name: input.name,
			subject: input.subject ?? source?.subject ?? "",
			previewText: input.previewText ?? source?.previewText ?? "",
			...content,
		});
		return { ...toTemplate(template.toObject()), content: getTemplateContent(template.toObject()) };
	},
});

const updateTemplate = defineAction({
	name: "update_template",
	tryWithoutPlan: true,
	title: "Update a template",
	group: TEMPLATES,
	description: "Renames a template or changes its subject, preview text or content. Send only the fields to change; format goes with content. Issues started from it before keep what they had.",
	http: { method: "PATCH", path: "/templates/{id}" },
	idempotent: true,
	example: { name: "Monthly letter" },
	input: z.object({
		id: idInput("template"),
		name: nameInput.optional(),
		subject: z.string().trim().max(200).optional().describe("Its subject line"),
		previewText: z.string().trim().max(300).optional().describe("Its preview text"),
		format: z.enum(FORMATS).optional().describe("With content: the format it is in. Default: the template's."),
		content: z.string().max(MAX_BODY_BYTES).optional().describe("Its body, 500 KB at most"),
	}),
	output: TemplateDetailSchema,
	handler: async ({ account, input }) => {
		const template = await findTemplate(account, input.id);
		if (input.format !== undefined && input.content === undefined) throw actionError("validation_failed", "format: send content with it");
		const set = {
			...(input.name !== undefined && { name: input.name }),
			...(input.subject !== undefined && { subject: input.subject }),
			...(input.previewText !== undefined && { previewText: input.previewText }),
			...(input.content !== undefined && readBody(input.format ?? template.format, input.content)),
		};
		if (Object.keys(set).length > 0) await IssueTemplate.updateOne(scoped(account, { _id: template._id }), { $set: set });
		const fresh = await findTemplate(account, input.id);
		return { ...toTemplate(fresh), content: getTemplateContent(fresh) };
	},
});

const deleteTemplate = defineAction({
	name: "delete_template",
	tryWithoutPlan: true,
	title: "Delete a template",
	group: TEMPLATES,
	description: "Deletes a saved issue template. The campaigns started from it stay as they are.",
	http: { method: "DELETE", path: "/templates/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("template") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const template = await findTemplate(account, input.id);
		await IssueTemplate.deleteOne(scoped(account, { _id: template._id }));
		return { id: input.id, deleted: true };
	},
});

function readSnippet(content) {
	const html = cleanRichHtml(textToRich(content));
	if (!hasContent(html)) throw actionError("validation_failed", "content: the snippet is empty");
	return html;
}

const snippetContentInput = z.string().max(MAX_SNIPPET_LENGTH).describe(`The snippet: HTML, or plain paragraphs separated by a blank line, ${MAX_SNIPPET_LENGTH} characters at most. It is cleaned like an issue's content.`);

const listSnippets = defineAction({
	name: "list_snippets",
	tryWithoutPlan: true,
	title: "List snippets",
	group: SNIPPETS,
	description: "Lists the account's snippets by name with their content. A snippet is a piece of content written once, like a sign-off or a sponsor's blurb, that the editor inserts from its / menu.",
	http: { method: "GET", path: "/snippets" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ snippets: z.array(SnippetSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const snippets = await Snippet.find(scoped(account, newsletter ? { newsletterId: newsletter._id } : {})).sort({ name: 1, _id: 1 }).lean();
		return { snippets: snippets.map(toSnippet) };
	},
});

const createSnippet = defineAction({
	name: "create_snippet",
	tryWithoutPlan: true,
	title: "Create a snippet",
	group: SNIPPETS,
	description: `Saves a snippet for the editor's / menu, ${MAX_SNIPPETS_PER_NEWSLETTER} at most for each newsletter.`,
	http: { method: "POST", path: "/snippets", status: 201 },
	rateLimit: { limit: 120, window: "1 h" },
	example: { name: "Sign-off", content: "Thanks for reading.\n\nSee you next week." },
	input: z.object({ newsletter: newsletterInput, name: nameInput, content: snippetContentInput }),
	output: SnippetSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const html = readSnippet(input.content);
		if ((await countIn(Snippet, account, newsletter._id)) >= MAX_SNIPPETS_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has ${MAX_SNIPPETS_PER_NEWSLETTER} snippets at most`);
		}
		const snippet = await Snippet.create({ accountId: account._id, newsletterId: newsletter._id, name: input.name, html });
		return toSnippet(snippet.toObject());
	},
});

const updateSnippet = defineAction({
	name: "update_snippet",
	tryWithoutPlan: true,
	title: "Update a snippet",
	group: SNIPPETS,
	description: "Renames a snippet or changes its content. Issues it was inserted into keep what they had.",
	http: { method: "PATCH", path: "/snippets/{id}" },
	idempotent: true,
	example: { name: "Signature" },
	input: z.object({ id: idInput("snippet"), name: nameInput.optional(), content: snippetContentInput.optional() }),
	output: SnippetSchema,
	handler: async ({ account, input }) => {
		const snippet = await findSnippet(account, input.id);
		const set = { ...(input.name !== undefined && { name: input.name }), ...(input.content !== undefined && { html: readSnippet(input.content) }) };
		if (Object.keys(set).length > 0) await Snippet.updateOne(scoped(account, { _id: snippet._id }), { $set: set });
		return toSnippet(await findSnippet(account, input.id));
	},
});

const deleteSnippet = defineAction({
	name: "delete_snippet",
	tryWithoutPlan: true,
	title: "Delete a snippet",
	group: SNIPPETS,
	description: "Deletes a snippet. The issues it was inserted into keep their copy.",
	http: { method: "DELETE", path: "/snippets/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("snippet") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const snippet = await findSnippet(account, input.id);
		await Snippet.deleteOne(scoped(account, { _id: snippet._id }));
		return { id: input.id, deleted: true };
	},
});

export const templateActions = [listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, listSnippets, createSnippet, updateSnippet, deleteSnippet];
