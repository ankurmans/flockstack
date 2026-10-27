import { emitRecordEvent } from "@/lib/record-events";
import { scoped } from "@/lib/account-scope";
import { enrollOnFieldsChanged } from "@/lib/automation-triggers";
import { toCell } from "@/lib/contacts-csv";
import { listCustomFields, parseFieldValue } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { getSurveyUrl, verifySubscriberToken } from "@/lib/subscriber-links";
import { FIELD_TYPES_FOR_QUESTION, answerText, parseAnswers, summarizeResponses } from "@/lib/survey-rules";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Survey from "@/models/Survey";
import SurveyResponse from "@/models/SurveyResponse";

// Surveys (models/Survey.js): readers answer on the newsletter's website; a subscriber who came through their signed link
// (lib/subscriber-links.js) answers once, and again replaces it, with the answers saved to the custom fields the
// questions name. Summaries and the CSV read the responses back, a page at a time.

// Enough for a summary that reads every response; past it the summary covers the newest.
export const SUMMARY_LIMIT = 10_000;
const PAGE = 1000;

// The survey a link names, whatever its account: its ID is in the link.
export async function findPublicSurvey(surveyId) {
	if (!isObjectIdString(String(surveyId ?? ""))) return null;
	await connectDb();
	return Survey.findOne({ _id: String(surveyId).toLowerCase() }).setOptions({ crossAccount: true }).lean();
}

// The open survey a newsletter shows after signup or on unsubscribe, if it has one.
export function findPlacedSurvey(newsletter, placement) {
	return Survey.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, [`placement.${placement}`]: true, closed: { $ne: true } }))
		.sort({ updatedAt: -1 })
		.lean();
}

// The link that opens a placed survey for one subscriber, or null when the newsletter has none.
export async function getPlacedSurveyUrl(newsletter, placement, contactId) {
	const survey = await findPlacedSurvey(newsletter, placement);
	if (!survey) return null;
	const from = placement === "afterSignup" ? "signup" : "unsubscribe";
	return getSurveyUrl({ contactId, newsletterId: newsletter._id }, newsletter, { surveyId: String(survey._id), from });
}

// Answers saved to the fields their questions name, where the field takes them.
async function getFieldSet(survey, answers) {
	const named = survey.questions.filter((question) => question.fieldKey && answers[question.id] !== undefined);
	if (named.length === 0) return {};
	const fields = new Map((await listCustomFields(survey.accountId, survey.newsletterId)).map((field) => [field.key, field]));
	const set = {};
	for (const question of named) {
		const field = fields.get(question.fieldKey);
		if (!field || !FIELD_TYPES_FOR_QUESTION[question.type].includes(field.type)) continue;
		const value = answers[question.id];
		const parsed = parseFieldValue(field.type, field.type === "list" && field.multiple && !Array.isArray(value) ? [value] : value, field);
		if (!parsed.problem && parsed.value !== null) set[`fields.${field.key}`] = parsed.value;
	}
	return set;
}

// A reader's submission. read(question): what the form sent for it. token: a subscriber's survey link, or null.
// { ok, survey } once stored, or { problem } ("invalid" for a link that isn't one, "closed", or what to fix).
export async function submitSurvey({ surveyId, token, source = "page", read }) {
	const survey = await findPublicSurvey(surveyId);
	if (!survey) return { problem: "invalid" };
	if (survey.closed) return { problem: "closed" };
	const reference = token ? verifySubscriberToken("survey", token) : null;
	if (token && (!reference || reference.newsletterId !== String(survey.newsletterId))) return { problem: "invalid" };
	const parsed = parseAnswers(survey.questions, read);
	if (parsed.problem) return { problem: parsed.problem };
	const where = ["signup", "unsubscribe"].includes(source) ? source : "page";
	const account = { _id: survey.accountId };
	const contact = reference ? await Contact.findOne(scoped(account, { _id: reference.contactId, newsletterId: survey.newsletterId })).select({ _id: 1, accountId: 1, newsletterId: 1, status: 1, tags: 1 }).lean() : null;
	if (contact) {
		const before = await SurveyResponse.findOneAndUpdate(
			scoped(account, { surveyId: survey._id, contactId: contact._id }),
			{ $set: { answers: parsed.answers, source: where, newsletterId: survey.newsletterId } },
			{ upsert: true, returnDocument: "before" }
		).lean();
		if (JSON.stringify(before?.answers) !== JSON.stringify(parsed.answers)) {
			const response = before ?? await SurveyResponse.findOne(scoped(account, { surveyId: survey._id, contactId: contact._id })).select({ _id: 1 }).lean();
			if (response) await emitRecordEvent("survey.responded", { accountId: survey.accountId, newsletterId: survey.newsletterId, id: response._id, parentId: survey._id });
		}
		const set = await getFieldSet(survey, parsed.answers);
		if (Object.keys(set).length > 0) {
			await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set });
			await enrollOnFieldsChanged(contact, Object.keys(set).map((path) => path.slice("fields.".length)));
		}
	} else {
		const response = await SurveyResponse.create({ accountId: survey.accountId, newsletterId: survey.newsletterId, surveyId: survey._id, source: where, answers: parsed.answers });
		await emitRecordEvent("survey.responded", { accountId: survey.accountId, newsletterId: survey.newsletterId, id: response._id, parentId: survey._id });
	}
	return { ok: true, survey };
}

async function* readResponses(account, survey, limit = Number.POSITIVE_INFINITY) {
	let read = 0;
	let before = null;
	while (read < limit) {
		const page = await SurveyResponse.find(scoped(account, { surveyId: survey._id, ...(before && { _id: { $lt: before } }) }))
			.sort({ _id: -1 })
			.limit(Math.min(PAGE, limit - read))
			.lean();
		if (page.length === 0) return;
		yield page;
		read += page.length;
		before = page.at(-1)._id;
	}
}

export async function summarizeSurvey(account, survey) {
	const responses = [];
	for await (const page of readResponses(account, survey, SUMMARY_LIMIT)) responses.push(...page);
	const total = await SurveyResponse.countDocuments(scoped(account, { surveyId: survey._id }));
	return { responses: total, questions: summarizeResponses(survey.questions, responses) };
}

// Every response as CSV, newest first: when, who (subscribers' emails), where from, then one column per question.
export async function getResponsesCsv(account, survey) {
	const header = ["submitted_at", "email", "source", ...survey.questions.map(({ label }) => label)].map(toCell).join(",");
	const rows = [header];
	for await (const page of readResponses(account, survey)) {
		const contactIds = [...new Set(page.map(({ contactId }) => contactId && String(contactId)).filter(Boolean))];
		const contacts = contactIds.length > 0 ? await Contact.find(scoped(account, { _id: { $in: contactIds } })).select({ email: 1 }).lean() : [];
		const emails = new Map(contacts.map(({ _id, email }) => [String(_id), email]));
		for (const response of page) {
			const cells = [
				new Date(response.updatedAt ?? response.createdAt).toISOString(),
				response.contactId ? (emails.get(String(response.contactId)) ?? "") : "",
				response.source,
				...survey.questions.map((question) => answerText(response.answers?.[question.id])),
			];
			rows.push(cells.map(toCell).join(","));
		}
	}
	return { csv: `${rows.join("\r\n")}\r\n`, count: rows.length - 1 };
}

export async function deleteSurveyResponses(account, survey) {
	await SurveyResponse.deleteMany(scoped(account, { surveyId: survey._id }));
}
