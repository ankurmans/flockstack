import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, form as fields, readerRoute, startTestApp, withEnv } from "./helpers/app.mjs";
import { api, creator, nextIp } from "./helpers/growth.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

let app;
let m;
let n = 0;
before(async () => {
	app = await startTestApp();
	m = {
		post: await readerRoute("app/f/[id]/route.js"),
		archive: await import("../app/archive/actions.js"),
		flows: await import("../lib/signup-flows.js"),
		links: await import("../lib/signup-flow-links.js"),
		surveyActions: await import("../app/survey/actions.js"),
		Contact: (await import("../models/Contact.js")).default,
		SurveyResponse: (await import("../models/SurveyResponse.js")).default,
		Survey: (await import("../models/Survey.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Account: (await import("../models/Account.js")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		page: (await import("../app/signup-flow/page.js")).default,
		pageMetadata: (await import("../app/signup-flow/page.js")).metadata,
		isTrackedPath: (await import("../lib/marketing/analytics-privacy.js")).isTrackedPath,
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
	};
});
after(() => app?.stop());
const owner = (options) => creator(`flow${++n}`, options);
async function survey(user) {
	const created = await api(user.key, "POST", "/surveys", { newsletter: user.slug, title: "What would you like?", questions: [{ type: "short_text", label: "Your goal", required: true }] });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	return created.body;
}
async function makeForm(user, body = {}) {
	const result = await api(user.key, "POST", "/forms", { newsletter: user.slug, name: "Ordered signup", ...body });
	assert.equal(result.status, 201, JSON.stringify(result.body));
	return result.body;
}
async function post(form, email, json = true) {
	const ip = nextIp();
	const response = await runWithRequest({ headers: { "x-forwarded-for": ip } }, () => m.post.POST(new Request(`https://news.example.com/f/${form.id}`, {
		method: "POST", headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", accept: json ? "application/json" : "text/html", "x-forwarded-for": ip }, body: json ? JSON.stringify({ email }) : new URLSearchParams({ email }),
	}), { params: Promise.resolve({ id: form.id }) }));
	await flushAfter();
	return json ? { status: response.status, body: await response.json() } : response;
}
function read(url, overrides = {}) {
	const query = new URL(url).searchParams;
	return m.flows.readSignupFlow({ formId: query.get("f"), step: query.get("step"), token: query.get("token"), ...overrides });
}
const newsletterOf = (user) => m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();

test("ordered form steps validate survey ownership, repetition and closed surveys", async () => {
	const user = await owner();
	const foreign = await owner();
	const ours = await survey(user), theirs = await survey(foreign);
	const flow = [{ type: "survey", surveyId: ours.id }, { type: "upsell" }, { type: "recommendations" }];
	const form = await makeForm(user, { flow, redirectUrl: "https://example.com/thanks" });
	assert.deepEqual(form.flow, flow);
	for (const bad of [[{ type: "survey" }], [{ type: "survey", surveyId: theirs.id }], [{ type: "upsell" }, { type: "upsell" }], [{ type: "redirect" }]]) assert.equal((await api(user.key, "PATCH", `/forms/${form.id}`, { flow: bad })).status, 400);
	assert.equal((await api(foreign.key, "PATCH", `/forms/${form.id}`, { flow: [] })).status, 404);
	await api(user.key, "PATCH", `/surveys/${ours.id}`, { closed: true });
	assert.equal((await api(user.key, "PATCH", `/forms/${form.id}`, { flow })).status, 400);
	assert.equal((await api(user.key, "PATCH", `/forms/${form.id}`, { flow: [] })).status, 200);
});

test("new pending readers get a private survey flow; existing addresses never get a subscriber capability", async () => {
	const user = await owner();
	const ours = await survey(user);
	const form = await makeForm(user, { flow: [{ type: "survey", surveyId: ours.id }, { type: "upsell" }], redirectUrl: "https://example.com/finish" });
	const joined = await post(form, "new-reader@example.com");
	assert.equal(joined.status, 200); assert.equal(joined.body.pending, true);
	const url = joined.body.redirectUrl;
	assert.equal(new URL(url).pathname, "/signup-flow");
	const page = await read(url);
	assert.equal(page.isPending, true); assert.ok(page.survey.token); assert.equal(page.survey.title, ours.title);
	const answer = await runWithRequest({ headers: { "x-forwarded-for": nextIp() } }, () => m.surveyActions.answerSurvey(ours.id, page.survey.token, "signup", null, fields({ [ours.questions[0].id]: "PRIVATE_READER_GOAL" })));
	assert.equal(answer.ok, true);
	const contact = await m.Contact.findOne({ accountId: user.accountId, email: "new-reader@example.com" }).lean();
	assert.equal(await m.SurveyResponse.countDocuments({ accountId: user.accountId, contactId: contact._id }), 1);
	const repeated = await post(form, contact.email);
	assert.equal(new URL(repeated.body.redirectUrl).searchParams.has("token"), false);
	const publicPage = await read(repeated.body.redirectUrl);
	assert.equal(publicPage.survey.token, null);
	assert.ok(!JSON.stringify(publicPage).includes("PRIVATE_READER_GOAL"));
	assert.equal((await read(page.nextUrl)).nextUrl, "https://example.com/finish");
	assert.equal(await read(url, { token: `${new URL(url).searchParams.get("token")}x` }), null);
	assert.equal(await read(url, { now: Date.now() + m.links.SIGNUP_FLOW_MAX_AGE_MS + 2000 }), null);
	const other = await owner(); const otherForm = await makeForm(other, { flow: [{ type: "upsell" }] });
	assert.equal(await read(url, { formId: otherForm.id }), null);
	await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { status: "unsubscribed" } });
	assert.equal(await read(url), null);
});

test("plain HTML form posts open the flow, and empty flow keeps the previous redirect behavior", async () => {
	const user = await owner();
	const form = await makeForm(user, { flow: [{ type: "upsell" }], redirectUrl: "https://example.com/finished" });
	const response = await post(form, "html-reader@example.com", false);
	assert.equal(response.status, 303);
	assert.equal(new URL(response.headers.get("location")).pathname, "/signup-flow");
	assert.ok((await read(response.headers.get("location"))).isPending);
	await api(user.key, "PATCH", `/forms/${form.id}`, { flow: [] });
	const plain = await post(form, "second-html-reader@example.com", false);
	assert.equal(plain.headers.get("location"), "https://example.com/finished");
});

test("the paid offer is only a current public plan link, and recommendations never enroll a reader on load", async () => {
	const user = await owner();
	const other = await owner();
	await api(user.key, "POST", "/recommendations", { newsletter: user.slug, slug: other.slug, pitch: "Read this too." });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTier: { enabled: true, monthlyCents: 500 } } });
	await m.Account.updateOne({ _id: user.accountId }, { $set: { payments: { stripeAccountId: "acct_synthetic_flow", chargesEnabled: true, detailsSubmitted: true } } });
	const form = await makeForm(user, { flow: [{ type: "upsell" }, { type: "recommendations" }] });
	const response = await post(form, "offer-reader@example.com");
	const page = await read(response.body.redirectUrl);
	assert.ok(page.upgradeUrl?.endsWith("/subscribe"), JSON.stringify(page));
	assert.ok(!page.upgradeUrl.includes("offer-reader"));
	assert.equal((await read(page.nextUrl)).recommendations, undefined, "pending reader must confirm first");
	const contact = await m.Contact.findOne({ accountId: user.accountId, email: "offer-reader@example.com" }).lean();
	await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { status: "active" } });
	const recommendations = await read(page.nextUrl);
	assert.ok(recommendations.recommendations?.recommendations.length, JSON.stringify(recommendations));
	assert.equal(await m.Contact.countDocuments({ accountId: other.accountId, email: contact.email }), 0);
	await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { tier: "paid", paidUntil: new Date(Date.now() + 86400000) } });
	assert.equal((await read(response.body.redirectUrl)).upgradeUrl, undefined);
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "paidTier.enabled": false } });
	assert.equal((await read(response.body.redirectUrl, { token: null })).upgradeUrl, undefined);
});

test("one form can supply archive, popup and gate steps; clearing or deleting an old default preserves a newer one", async () => {
	const user = await owner();
	const form = await makeForm(user, { flow: [{ type: "upsell" }], archiveDefault: true });
	assert.equal(form.archiveDefault, true);
	for (const via of ["website", "popup", "gate"]) {
		const result = await runWithRequest({ headers: { "x-forwarded-for": nextIp() } }, () => m.archive.subscribe(null, fields({ newsletter: user.slug, email: `${via}-flow@example.com`, via })));
		assert.equal(new URL(result.flowUrl).searchParams.get("f"), form.id);
		assert.ok(new URL(result.flowUrl).searchParams.get("token"));
	}
	const again = await runWithRequest({ headers: { "x-forwarded-for": nextIp() } }, () => m.archive.subscribe(null, fields({ newsletter: user.slug, email: "website-flow@example.com" })));
	assert.equal(new URL(again.flowUrl).searchParams.has("token"), false);
	const next = await makeForm(user, { flow: [{ type: "recommendations" }], archiveDefault: true });
	await api(user.key, "PATCH", `/forms/${form.id}`, { archiveDefault: false });
	assert.equal(String((await newsletterOf(user)).signupFlowFormId), next.id);
	await api(user.key, "DELETE", `/forms/${form.id}`);
	assert.equal(String((await newsletterOf(user)).signupFlowFormId), next.id);
	await api(user.key, "DELETE", `/forms/${next.id}`);
	assert.equal((await newsletterOf(user)).signupFlowFormId, undefined);
});

test("the page is private from analytics, works on newsletter hosts without login and exposes optional navigation", async () => {
	const user = await owner();
	const ours = await survey(user);
	const form = await makeForm(user, { flow: [{ type: "survey", surveyId: ours.id }, { type: "upsell" }], redirectUrl: "https://example.com/done" });
	const response = await post(form, "page-reader@example.com");
	const url = new URL(response.body.redirectUrl);
	const html = renderToStaticMarkup(createElement(m.TooltipProvider, null, await anonymous(() => m.page({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }))));
	assert.match(html, /What would you like/); assert.match(html, /Skip the remaining steps/); assert.match(html, /Check your email to confirm/);
	assert.equal(m.pageMetadata.referrer, "no-referrer");
	assert.equal(m.pageMetadata.robots.index, false);
	assert.equal(m.isTrackedPath("/signup-flow"), false);
	for (const address of [url.toString(), `http://localhost:3000${url.pathname}${url.search}`]) {
		const result = await withEnv({ ARCHIVE_TRUSTED_HOSTS: url.hostname }, () => anonymous(() => m.proxy(new m.NextRequest(address))));
		assert.notEqual(result.headers.get("location")?.includes("/signin"), true);
	}
});
