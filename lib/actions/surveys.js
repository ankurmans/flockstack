import { emitRecordEvent } from "@/lib/record-events";
import "server-only";
import crypto from "node:crypto";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { GROUP } from "@/lib/actions/polls";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { listCustomFields } from "@/lib/custom-fields";
import { getSurveyUrl } from "@/lib/subscriber-links";
import {
	FIELD_TYPES_FOR_QUESTION,
	MAX_CHOICES,
	MAX_QUESTIONS,
	MAX_SURVEYS_PER_NEWSLETTER,
	QUESTION_TYPES,
	getQuestionProblem,
	isChoice,
	isQuestionId,
} from "@/lib/survey-rules";
import { deleteSurveyResponses, getResponsesCsv, summarizeSurvey } from "@/lib/surveys";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Survey from "@/models/Survey";
import SurveyResponse from "@/models/SurveyResponse";

const surveyId = idInput("survey");
const RESPONSES_PAGE = 100;

const QuestionInput = z.object({
	id: z.string().trim().max(13).optional().describe("Keep a question's id when editing, so its answers stay with it. New questions get one."),
	type: z
		.enum(QUESTION_TYPES)
		.describe("short_text, long_text, single_choice, multi_choice (with options), rating (1 to 5), nps (0 to 10) or yes_no"),
	label: z.string().trim().min(1).max(200).describe("The question"),
	options: z.array(z.string().trim().min(1).max(60)).max(MAX_CHOICES).optional().describe(`A choice's options, 2 to ${MAX_CHOICES}, without commas`),
	required: z.boolean().optional().describe("Readers have to answer it. Default: false."),
	fieldKey: z
		.string()
		.trim()
		.max(30)
		.nullable()
		.optional()
		.describe("A custom field a subscriber's answer is saved to: text for written answers, list or text for a choice, list for several, number for a rating, boolean for yes or no"),
});
const surveyShape = {
	title: z.string().trim().min(1).max(100).describe("The survey's title, on its page"),
	intro: z.string().trim().max(500).nullable().optional().describe("A few words under the title"),
	questions: z.array(QuestionInput).min(1).max(MAX_QUESTIONS).describe(`1 to ${MAX_QUESTIONS} questions`),
	afterSignup: z.boolean().optional().describe("Ask it of new subscribers right after they sign up on the website. One survey of a newsletter does."),
	onUnsubscribe: z.boolean().optional().describe("Ask it on the unsubscribe page, once they've left: why they're leaving. One survey of a newsletter does."),
	thankYou: z.string().trim().max(300).nullable().optional().describe("What the page says once it's sent"),
	closed: z.boolean().optional().describe("Stop taking answers"),
};

const QuestionSchema = z.object({
	id: z.string(),
	type: z.enum(QUESTION_TYPES),
	label: z.string(),
	options: z.array(z.string()),
	required: z.boolean(),
	fieldKey: z.string().nullable(),
});
const SurveySchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	title: z.string(),
	intro: z.string().nullable(),
	questions: z.array(QuestionSchema),
	afterSignup: z.boolean(),
	onUnsubscribe: z.boolean(),
	thankYou: z.string().nullable(),
	closed: z.boolean(),
	url: z.string().describe("Its page on the newsletter's website, for anyone; answers there aren't tied to a subscriber"),
	responses: z.number().int(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const SummarySchema = z.array(
	z.object({
		id: z.string(),
		label: z.string(),
		type: z.enum(QUESTION_TYPES),
		answered: z.number().int(),
		counts: z.array(z.object({ option: z.string(), count: z.number().int() })).optional().describe("Choices, ratings and yes or no"),
		average: z.number().nullable().optional().describe("Ratings"),
		nps: z.number().nullable().optional().describe("nps questions: promoters (9-10) minus detractors (0-6), in percent"),
		latest: z.array(z.string()).optional().describe("Written answers, the newest ten"),
	})
);

async function toSurvey(survey, newsletter) {
	return {
		id: String(survey._id),
		newsletterId: String(survey.newsletterId),
		title: survey.title,
		intro: survey.intro || null,
		questions: survey.questions.map((question) => ({
			id: question.id,
			type: question.type,
			label: question.label,
			options: question.options ?? [],
			required: Boolean(question.required),
			fieldKey: question.fieldKey || null,
		})),
		afterSignup: Boolean(survey.placement?.afterSignup),
		onUnsubscribe: Boolean(survey.placement?.onUnsubscribe),
		thankYou: survey.thankYou || null,
		closed: Boolean(survey.closed),
		url: getSurveyUrl(null, newsletter, { surveyId: String(survey._id) }),
		responses: await SurveyResponse.countDocuments(scoped(survey.accountId, { surveyId: survey._id })),
		createdAt: toIso(survey.createdAt),
		updatedAt: toIso(survey.updatedAt),
	};
}

async function findSurvey(account, id) {
	const value = String(id ?? "").trim().toLowerCase();
	const survey = isObjectIdString(value) ? await Survey.findOne(scoped(account, { _id: value })).lean() : null;
	if (!survey) throw actionError("not_found", "Survey not found");
	const newsletter = await Newsletter.findOne(scoped(account, { _id: survey.newsletterId })).lean();
	return { survey, newsletter };
}

function newQuestionId() {
	return `q${crypto.randomBytes(5).toString("hex")}`;
}

// The questions as stored: checked, each with an id, and each field they name one that takes their answers.
async function toQuestions(account, newsletterId, questions) {
	const fields = new Map((await listCustomFields(account, newsletterId)).map((field) => [field.key, field]));
	const ids = new Set();
	return questions.map((question, index) => {
		const problem = getQuestionProblem(question, index);
		if (problem) throw actionError("validation_failed", problem);
		const fieldKey = question.fieldKey?.toLowerCase() || null;
		if (fieldKey) {
			const field = fields.get(fieldKey);
			if (!field) throw actionError("validation_failed", `questions[${index + 1}]: the newsletter has no custom field ${fieldKey}`);
			if (!FIELD_TYPES_FOR_QUESTION[question.type].includes(field.type)) {
				throw actionError("validation_failed", `questions[${index + 1}]: a ${question.type} answer can't be saved to a ${field.type} field`);
			}
		}
		const id = isQuestionId(question.id) && !ids.has(question.id) ? question.id : newQuestionId();
		ids.add(id);
		return {
			id,
			type: question.type,
			label: question.label,
			...(isChoice(question.type) && { options: question.options.map((option) => option.trim()) }),
			...(question.required && { required: true }),
			...(fieldKey && { fieldKey }),
		};
	});
}

function readSettings(input) {
	const set = {};
	const unset = {};
	for (const key of ["intro", "thankYou"]) if (input[key] !== undefined) (input[key] ? set : unset)[key] = input[key] || 1;
	if (input.title !== undefined) set.title = input.title;
	if (input.closed !== undefined) set.closed = input.closed;
	for (const placement of ["afterSignup", "onUnsubscribe"]) if (input[placement] !== undefined) set[`placement.${placement}`] = input[placement];
	return { set, unset };
}

// A placement belongs to one survey of a newsletter: the one just given it.
async function takePlacements(account, survey, input) {
	for (const placement of ["afterSignup", "onUnsubscribe"]) {
		if (input[placement] !== true) continue;
		await Survey.updateMany(scoped(account, { newsletterId: survey.newsletterId, _id: { $ne: survey._id }, [`placement.${placement}`]: true }), {
			$set: { [`placement.${placement}`]: false },
		});
	}
}

const listSurveys = defineAction({
	name: "list_surveys",
	tryWithoutPlan: true,
	title: "List surveys",
	group: GROUP,
	description: "Lists a newsletter's surveys, newest first, with their questions, where they're shown and how many responses each has.",
	http: { method: "GET", path: "/surveys" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter.") }),
	output: z.object({ surveys: z.array(SurveySchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const surveys = await Survey.find(scoped(account, { newsletterId: newsletter._id })).sort({ createdAt: -1, _id: -1 }).lean();
		return { surveys: await Promise.all(surveys.map((survey) => toSurvey(survey, newsletter))) };
	},
});

const getSurvey = defineAction({
	name: "get_survey",
	tryWithoutPlan: true,
	title: "Get a survey",
	group: GROUP,
	description:
		"Gets a survey with a summary of its answers: counts per option, the average rating, the NPS score and the newest written answers. list_survey_responses and export_survey_responses have every response.",
	http: { method: "GET", path: "/surveys/{id}" },
	readOnly: true,
	input: z.object({ id: surveyId }),
	output: SurveySchema.extend({ summary: SummarySchema }),
	handler: async ({ account, input }) => {
		const { survey, newsletter } = await findSurvey(account, input.id);
		const { questions } = await summarizeSurvey(account, survey);
		return { ...(await toSurvey(survey, newsletter)), summary: questions };
	},
});

const createSurvey = defineAction({
	name: "create_survey",
	tryWithoutPlan: true,
	title: "Create a survey",
	group: GROUP,
	description: `Creates a survey on the newsletter's website, up to ${MAX_SURVEYS_PER_NEWSLETTER} a newsletter: short or long answers, one or several choices, a rating, an NPS question, yes or no. A question can save a subscriber's answer to a custom field. Show it after signup (afterSignup) or on the unsubscribe page to ask why (onUnsubscribe), or link to its url.`,
	http: { method: "POST", path: "/surveys", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { title: "Help shape the newsletter", questions: [{ type: "single_choice", label: "How often should it come?", options: ["Weekly", "Monthly"] }] },
	input: z.object({ newsletter: newsletterInput, ...surveyShape }),
	output: SurveySchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		if ((await Survey.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_SURVEYS_PER_NEWSLETTER) {
			throw actionError("validation_failed", `A newsletter has up to ${MAX_SURVEYS_PER_NEWSLETTER} surveys`);
		}
		const questions = await toQuestions(account, newsletter._id, input.questions);
		const { set } = readSettings(input);
		const placement = expandPlacement(set);
		const created = await Survey.create({ accountId: account._id, newsletterId: newsletter._id, questions, ...set, ...placement });
		await takePlacements(account, created, input);
		await emitRecordEvent("survey.created", { accountId: account._id, newsletterId: newsletter._id, id: created._id });
		return toSurvey(created.toObject(), newsletter);
	},
});

// Survey.create takes nested objects, not dotted paths.
function expandPlacement(set) {
	const placement = {};
	for (const key of ["afterSignup", "onUnsubscribe"]) {
		if (`placement.${key}` in set) {
			placement[key] = set[`placement.${key}`];
			delete set[`placement.${key}`];
		}
	}
	return Object.keys(placement).length > 0 ? { placement } : {};
}

const updateSurvey = defineAction({
	name: "update_survey",
	tryWithoutPlan: true,
	title: "Update a survey",
	group: GROUP,
	description:
		"Changes a survey's title, questions, placement or thank-you words, or closes it. Send questions with their ids to keep their answers; a question left out keeps its answers in the CSV but leaves the summary.",
	http: { method: "PATCH", path: "/surveys/{id}" },
	idempotent: true,
	example: { closed: true },
	input: z.object({ id: surveyId, ...Object.fromEntries(Object.entries(surveyShape).map(([key, schema]) => [key, schema.optional()])) }),
	output: SurveySchema,
	handler: async ({ account, input }) => {
		const { survey, newsletter } = await findSurvey(account, input.id);
		const { set, unset } = readSettings(input);
		if (input.questions) set.questions = await toQuestions(account, survey.newsletterId, input.questions);
		await Survey.updateOne(scoped(account, { _id: survey._id }), { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) });
		await takePlacements(account, survey, input);
		await emitRecordEvent("survey.updated", { accountId: account._id, newsletterId: newsletter._id, id: survey._id });
		return toSurvey((await findSurvey(account, survey._id)).survey, newsletter);
	},
});

const deleteSurvey = defineAction({
	name: "delete_survey",
	tryWithoutPlan: true,
	title: "Delete a survey",
	group: GROUP,
	description: "Deletes a survey and all its responses. It can't be undone. Values its answers saved to custom fields stay on the contacts.",
	http: { method: "DELETE", path: "/surveys/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: surveyId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const { survey } = await findSurvey(account, input.id);
		await deleteSurveyResponses(account, survey);
		await Survey.deleteOne(scoped(account, { _id: survey._id }));
		await emitRecordEvent("survey.deleted", { accountId: account._id, newsletterId: survey.newsletterId, id: survey._id });
		return { id: String(survey._id), deleted: true };
	},
});

const listSurveyResponses = defineAction({
	name: "list_survey_responses",
	tryWithoutPlan: true,
	title: "List a survey's responses",
	group: GROUP,
	description: `Lists a survey's responses, newest first, ${RESPONSES_PAGE} a page: the answers by question id, with the subscriber's email when they answered through their own link. Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/surveys/{id}/responses" },
	readOnly: true,
	input: z.object({ id: surveyId, cursor: z.string().max(100).optional().describe("nextCursor from the previous page") }),
	output: z.object({
		responses: z.array(
			z.object({
				id: z.string(),
				email: z.string().nullable().describe("The subscriber's, or null for a reader without a link"),
				source: z.enum(["page", "signup", "unsubscribe"]),
				answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
				submittedAt: dateOutput,
			})
		),
		nextCursor: z.string().nullable(),
	}),
	handler: async ({ account, input }) => {
		const { survey } = await findSurvey(account, input.id);
		if (input.cursor && !isObjectIdString(input.cursor)) throw actionError("validation_failed", "cursor: use the nextCursor of the previous page");
		const responses = await SurveyResponse.find(scoped(account, { surveyId: survey._id, ...(input.cursor && { _id: { $lt: input.cursor.toLowerCase() } }) }))
			.sort({ _id: -1 })
			.limit(RESPONSES_PAGE + 1)
			.lean();
		const page = responses.slice(0, RESPONSES_PAGE);
		const contactIds = page.map(({ contactId }) => contactId).filter(Boolean);
		const contacts = contactIds.length > 0 ? await Contact.find(scoped(account, { _id: { $in: contactIds } })).select({ email: 1 }).lean() : [];
		const emails = new Map(contacts.map(({ _id, email }) => [String(_id), email]));
		return {
			responses: page.map((response) => ({
				id: String(response._id),
				email: response.contactId ? (emails.get(String(response.contactId)) ?? null) : null,
				source: response.source ?? "page",
				answers: response.answers ?? {},
				submittedAt: toIso(response.updatedAt ?? response.createdAt),
			})),
			nextCursor: responses.length > RESPONSES_PAGE ? String(page.at(-1)._id) : null,
		};
	},
});

const exportSurveyResponses = defineAction({
	name: "export_survey_responses",
	tryWithoutPlan: true,
	title: "Export a survey's responses",
	group: GROUP,
	description: "Every response of a survey as CSV, newest first: when, the subscriber's email when they answered through their own link, where from, and a column per question.",
	http: { method: "GET", path: "/surveys/{id}/export" },
	readOnly: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: surveyId }),
	output: z.object({ csv: z.string(), count: z.number().int().describe("Responses in it") }),
	handler: async ({ account, input }) => getResponsesCsv(account, (await findSurvey(account, input.id)).survey),
});

export const surveyActions = [listSurveys, getSurvey, createSurvey, updateSurvey, deleteSurvey, listSurveyResponses, exportSurveyResponses];
