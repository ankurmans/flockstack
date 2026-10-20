import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSubscriberToken } from "../lib/subscriber-links.js";
import { parseAnswers, summarizeResponses } from "../lib/survey-rules.js";
import { form } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

let t;
let actions;
let SurveyResponse;

before(async () => {
	t = await setupAudienceTests();
	actions = await import("../app/survey/actions.js");
	SurveyResponse = (await import("../models/SurveyResponse.js")).default;
});

after(() => t?.app.stop());

const QUESTIONS = [
	{ type: "short_text", label: "Your name", fieldKey: "first_name" },
	{ type: "single_choice", label: "How often?", options: ["Weekly", "Monthly"], fieldKey: "frequency", required: true },
	{ type: "multi_choice", label: "Topics", options: ["News", "Deals", "Events"], fieldKey: "topics" },
	{ type: "rating", label: "How is it?" },
	{ type: "nps", label: "Recommend?" },
	{ type: "yes_no", label: "Keep the intro?", fieldKey: "likes_intro" },
	{ type: "long_text", label: "Anything else?" },
];

async function setupSurvey(email, body = {}) {
	const user = await t.customer(email);
	for (const field of [
		{ label: "First name", type: "text" },
		{ label: "Frequency", type: "list", options: ["Weekly", "Monthly"] },
		{ label: "Topics", type: "list", options: ["News", "Deals", "Events"], multiple: true },
		{ label: "Likes intro", type: "boolean" },
	]) {
		await t.api(user.key, "POST", "/custom-fields", field);
	}
	const created = await t.api(user.key, "POST", "/surveys", { title: "Help us", questions: QUESTIONS, ...body });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	await t.importReaders(user, 2);
	const contacts = (await t.api(user.key, "GET", "/contacts")).body.contacts;
	const token = (contact) => createSubscriberToken("survey", { contactId: contact.id, newsletterId: user.newsletterId });
	return { user, survey: created.body, contacts, token };
}

let visitor = 0;

// Each call comes from an address of its own, so the per-address rate limit isn't what a test meets.
function answer(survey, token, values, source = "page", ip = `203.0.113.${100 + ++visitor}`) {
	const byLabel = Object.fromEntries(survey.questions.map((question) => [question.label, question.id]));
	const data = new FormData();
	for (const [label, value] of Object.entries(values)) for (const item of [value].flat()) data.append(byLabel[label], String(item));
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.answerSurvey(survey.id, token, source, null, data));
}

describe("survey answers", () => {
	test("are read by the question's type and stored compactly", () => {
		const questions = QUESTIONS.map((question, index) => ({ ...question, id: `q${index}x`, options: question.options ?? [] }));
		const read = (values) => (question) => values[question.label];
		const ok = parseAnswers(questions, read({ "How often?": "monthly", Topics: ["events", "News"], "How is it?": "4", "Recommend?": "10", "Keep the intro?": "no", "Your name": "  Ann " }));
		assert.deepEqual(ok.answers, { q0x: "Ann", q1x: "Monthly", q2x: ["News", "Events"], q3x: 4, q4x: 10, q5x: false });
		for (const bad of [{ "How often?": "Daily" }, { "How often?": "Weekly", "How is it?": "6" }, { "How often?": "Weekly", "Recommend?": "11" }, { "How often?": "Weekly", Topics: ["Nope"] }, { "How often?": "Weekly", "Keep the intro?": "maybe" }]) {
			assert.ok(parseAnswers(questions, read(bad)).problem, JSON.stringify(bad));
		}
		assert.match(parseAnswers(questions, read({})).problem, /answer this one|at least one/);
	});

	test("add up per question", () => {
		const questions = [
			{ id: "qa", type: "nps", label: "N", options: [] },
			{ id: "qb", type: "single_choice", label: "C", options: ["A", "B"] },
		];
		const summary = summarizeResponses(questions, [{ answers: { qa: 10, qb: "A" } }, { answers: { qa: 9, qb: "A" } }, { answers: { qa: 3 } }, { answers: { qa: 8, qb: "B" } }]);
		assert.deepEqual({ average: summary[0].average, nps: summary[0].nps, answered: summary[0].answered }, { average: 7.5, nps: 25, answered: 4 });
		assert.deepEqual(summary[1].counts, [{ option: "A", count: 2 }, { option: "B", count: 1 }]);
	});
});

describe("surveys", () => {
	test("are checked when they're made", async () => {
		const user = await t.customer("surveys-checks@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Seats", type: "number" });
		const make = (questions) => t.api(user.key, "POST", "/surveys", { title: "S", questions });
		t.assertError(await make([{ type: "single_choice", label: "One?", options: ["Only"] }]), 400, "validation_failed");
		t.assertError(await make([{ type: "short_text", label: "Name", fieldKey: "nope" }]), 400, "validation_failed");
		t.assertError(await make([{ type: "short_text", label: "Name", fieldKey: "seats" }]), 400, "validation_failed");
		assert.equal((await make([{ type: "rating", label: "Rate", fieldKey: "seats" }])).status, 201, "a rating fits a number field");
		t.assertError(await make([{ type: "yes_no", label: "Yes?", fieldKey: "seats" }]), 400, "validation_failed");
	});

	test("save a subscriber's answers to their fields, once each, and count readers without a link apart", async () => {
		const { user, survey, contacts, token } = await setupSurvey("surveys-answers@example.com");
		const ann = contacts[0];
		const result = await answer(survey, token(ann), { "Your name": "Ann", "How often?": "Weekly", Topics: ["Events", "News"], "Keep the intro?": "yes", "How is it?": "5" });
		assert.deepEqual(result, { ok: true, thankYou: "Thanks, your answers are in." });
		let stored = await t.m.Contact.findOne({ accountId: user.accountId, _id: ann.id }).lean();
		assert.deepEqual(stored.fields, { first_name: "Ann", frequency: "Weekly", topics: ["News", "Events"], likes_intro: true });

		await answer(survey, token(ann), { "How often?": "Monthly", "Your name": "Ann B" });
		stored = await t.m.Contact.findOne({ accountId: user.accountId, _id: ann.id }).lean();
		assert.equal(stored.fields.frequency, "Monthly");
		assert.equal(await SurveyResponse.countDocuments({ accountId: user.accountId, surveyId: survey.id }), 1, "answering again replaces");

		assert.ok((await answer(survey, token(contacts[1]), { "Your name": "No frequency" })).error, "a required question");
		assert.deepEqual(await answer(survey, null, { "How often?": "Weekly", "Anything else?": "Hi" }, "page", "198.18.5.5"), { ok: true, thankYou: "Thanks, your answers are in." });
		assert.equal(await SurveyResponse.countDocuments({ accountId: user.accountId, surveyId: survey.id }), 2);
		const untouched = await t.m.Contact.findOne({ accountId: user.accountId, _id: contacts[1].id }).lean();
		assert.equal(untouched.fields?.frequency, undefined, "an anonymous answer changes no contact");
	});

	test("refuse forged links and links of another kind or newsletter", async () => {
		const { user, survey, contacts, token } = await setupSurvey("surveys-tamper@example.com");
		const good = token(contacts[0]);
		const [payload, signature] = good.split(".");
		const forged = `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		const wrongKind = createSubscriberToken("poll", { contactId: contacts[0].id, newsletterId: user.newsletterId });
		for (const bad of [forged, wrongKind]) assert.match((await answer(survey, bad, { "How often?": "Weekly" })).error, /link doesn't work/);
		const other = await setupSurvey("surveys-tamper-other@example.com");
		assert.match((await answer(other.survey, good, { "How often?": "Weekly" })).error, /link doesn't work/);
		assert.equal(await SurveyResponse.countDocuments({ accountId: user.accountId }), 0);
	});

	test("show up in the summary, the response list and the CSV", async () => {
		const { user, survey, contacts, token } = await setupSurvey("surveys-results@example.com");
		await answer(survey, token(contacts[0]), { "How often?": "Weekly", Topics: ["News"], "Recommend?": "10", "Anything else?": "Love it, \"really\"" }, "signup");
		await answer(survey, token(contacts[1]), { "How often?": "Monthly", "Recommend?": "5" }, "unsubscribe");
		const detail = (await t.api(user.key, "GET", `/surveys/${survey.id}`)).body;
		assert.equal(detail.responses, 2);
		const byLabel = Object.fromEntries(detail.summary.map((question) => [question.label, question]));
		assert.deepEqual(byLabel["How often?"].counts, [{ option: "Weekly", count: 1 }, { option: "Monthly", count: 1 }]);
		assert.deepEqual({ average: byLabel["Recommend?"].average, nps: byLabel["Recommend?"].nps }, { average: 7.5, nps: 0 });
		const list = (await t.api(user.key, "GET", `/surveys/${survey.id}/responses`)).body;
		assert.deepEqual(list.responses.map(({ source }) => source).sort(), ["signup", "unsubscribe"]);
		assert.ok(list.responses.every(({ email }) => email?.endsWith(".example.org")));
		const { csv, count } = (await t.api(user.key, "GET", `/surveys/${survey.id}/export`)).body;
		assert.equal(count, 2);
		const lines = csv.trim().split("\r\n");
		assert.equal(lines[0], "submitted_at,email,source,Your name,How often?,Topics,How is it?,Recommend?,Keep the intro?,Anything else?");
		assert.ok(lines.some((line) => line.includes(',signup,,Weekly,News,,10,,"Love it, ""really"""')));
	});

	test("are shown after signup and on the unsubscribe page, one survey each", async () => {
		const { user, survey, contacts } = await setupSurvey("surveys-placement@example.com", { afterSignup: true, onUnsubscribe: true });
		const second = await t.api(user.key, "POST", "/surveys", { title: "Second", questions: [{ type: "yes_no", label: "Fine?" }], afterSignup: true });
		const list = (await t.api(user.key, "GET", "/surveys")).body.surveys;
		const flags = Object.fromEntries(list.map(({ title, afterSignup, onUnsubscribe }) => [title, { afterSignup, onUnsubscribe }]));
		assert.deepEqual(flags, { "Help us": { afterSignup: false, onUnsubscribe: true }, Second: { afterSignup: true, onUnsubscribe: false } }, "a placement belongs to the latest");

		const archive = await import("../app/archive/actions.js");
		await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent", sentAt: new Date() });
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
		const signup = await t.m.Newsletter.findOne({ accountId: user.accountId }).lean();
		const joined = await runWithRequest({ headers: { "x-forwarded-for": "203.0.113.77" } }, () => archive.subscribe(null, form({ newsletter: signup.slug, email: "new@surveys-placement.example.org" })));
		const url = new URL(joined.survey);
		assert.deepEqual({ path: url.pathname, s: url.searchParams.get("s"), from: url.searchParams.get("from") }, { path: "/survey", s: second.body.id, from: "signup" });
		assert.ok(url.searchParams.get("token"), "a new contact answers as themselves");

		const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
		const page = await import("../app/unsubscribe/page.js");
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: contacts[0].id }, { $set: { status: "unsubscribed" } });
		const token = createUnsubscribeToken({ contactId: contacts[0].id, newsletterId: user.newsletterId });
		const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ token }) }));
		assert.ok(html.includes("Help us") && html.includes("How often?"), "the leaving survey asks why");
		const open = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ token: createUnsubscribeToken({ contactId: contacts[1].id, newsletterId: user.newsletterId }) }) }));
		assert.ok(!open.includes("How often?"), "nothing before they've left");
	});

	test("take no answers once closed, and go with their responses when deleted", async () => {
		const { user, survey, contacts, token } = await setupSurvey("surveys-closed@example.com");
		await answer(survey, token(contacts[0]), { "How often?": "Weekly" });
		await t.api(user.key, "PATCH", `/surveys/${survey.id}`, { closed: true });
		assert.match((await answer(survey, token(contacts[1]), { "How often?": "Weekly" })).error, /closed/);
		assert.deepEqual((await t.api(user.key, "DELETE", `/surveys/${survey.id}`)).body, { id: survey.id, deleted: true });
		assert.equal(await SurveyResponse.countDocuments({ accountId: user.accountId }), 0);
		const other = await t.customer("surveys-stranger@example.com");
		t.assertError(await t.api(other.key, "GET", `/surveys/${survey.id}`), 404, "not_found");
	});

	test("keep a question's answers across edits when its id is sent back", async () => {
		const { user, survey, contacts, token } = await setupSurvey("surveys-edit@example.com");
		await answer(survey, token(contacts[0]), { "How often?": "Weekly" });
		const frequency = survey.questions.find(({ label }) => label === "How often?");
		const edited = await t.api(user.key, "PATCH", `/surveys/${survey.id}`, { questions: [{ id: frequency.id, type: "single_choice", label: "How often would you like it?", options: ["Weekly", "Monthly"], required: true }] });
		assert.equal(edited.body.questions[0].id, frequency.id);
		const detail = (await t.api(user.key, "GET", `/surveys/${survey.id}`)).body;
		assert.deepEqual(detail.summary[0].counts, [{ option: "Weekly", count: 1 }, { option: "Monthly", count: 0 }]);
	});
});
