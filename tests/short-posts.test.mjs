import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, as, callApi, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { addReader, createPublisher, importModels } from "./helpers/community.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let app, m, sequence = 0;
before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = { ...await importModels(), page: (await import("../app/archive/[slug]/p/[post]/page.js")).default, data: await import("../lib/archive-data.js"), feed: await import("../lib/archive-feed.js"), markdown: await import("../lib/archive-markdown.js"), scheduling: await import("../lib/scheduling.js"), actions: await import("../app/(app)/campaigns/actions.js"), CampaignVersion: (await import("../models/CampaignVersion.js")).default, exports: await import("../lib/account-export-files.js"), ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default };
});
after(async () => app?.stop());
const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, ...(body && { body }) });
const publisher = () => createPublisher(m, `short-post-${++sequence}@example.com`);
const draft = (user, body = "A small observation from the garden.", extra = {}) => api(user, "POST", "/campaigns", { newsletter: user.slug, kind: "note", format: "markdown", content: body, ...extra });
const stored = (user, id) => m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
const send = (user, id) => api(user, "POST", `/campaigns/${id}/send`, {});

test("short posts start as title-free web drafts, retain their type in lists and copies, and reject email targeting", async () => {
	const user = await publisher(); const made = await draft(user); assert.equal(made.status, 201, JSON.stringify(made.body));
	assert.equal(made.body.kind, "note"); assert.equal(made.body.publishTo, "web"); assert.equal(made.body.status, "draft");
	assert.equal(made.body.subject, "A small observation from the garden.");
	const list = await api(user, "GET", `/campaigns?newsletter=${user.slug}&kind=note`); assert.equal(list.body.campaigns.length, 1); assert.equal(list.body.campaigns[0].kind, "note");
	const copy = await api(user, "POST", `/campaigns/${made.body.id}/duplicate`, {}); assert.equal(copy.status, 201); assert.equal(copy.body.kind, "note"); assert.equal(copy.body.publishTo, "web");
	for (const bad of [{ publishTo: "both" }, { subject: "A title" }, { previewText: "A subtitle" }, { audience: "paid" }, { format: "html", content: "<p>Designed document</p>" }, { content: "a".repeat(2001) }, { format: "rich", content: '<div data-access="paid"><p>Private text</p></div>' }, { format: "rich", content: '<div data-rss="true">Feed</div>' }]) {
		assert.equal((await draft(user, "Hello.", bad)).status, 400, JSON.stringify(bad));
	}
	assert.equal((await api(user, "PATCH", `/campaigns/${made.body.id}`, { publishTo: "email" })).status, 400);
	assert.equal((await api(user, "POST", `/campaigns/${made.body.id}/test`, {})).status, 400);
	assert.equal((await api(user, "POST", `/campaigns/${made.body.id}/send`, { audience: "paid" })).status, 400);
});

test("publishing creates a public page and RSS item with no visible title and sends no email or batch", async () => {
	const user = await publisher(); await addReader(m, user, "note-reader@example.com");
	const made = await draft(user, "A small **garden** observation.");
	const check = await api(user, "GET", `/campaigns/${made.body.id}/check`); assert.equal(check.status, 200);
	assert.ok(!JSON.stringify(check.body).includes("inboxes cut off"));
	const emailCount = platformEmails.length, sesCount = sesEmails.length, jobs = published.length;
	const sent = await send(user, made.body.id); assert.equal(sent.status, 200, JSON.stringify(sent.body)); assert.equal(sent.body.status, "sent");
	assert.equal(sent.body.stats.recipients, 0); assert.equal(platformEmails.length, emailCount); assert.equal(sesEmails.length, sesCount);
	assert.ok(published.slice(jobs).every(({ url }) => !url.endsWith("/send-batch")));
	assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: made.body.id }), 0);
	const row = await stored(user, made.body.id);
	const newsletter = await m.data.getArchiveNewsletter(user.slug);
	const issue = await m.data.getArchiveIssue(newsletter, row.archiveSlug); assert.equal(issue.kind, "note");
	const page = await anonymous(() => m.page({ params: Promise.resolve({ slug: user.slug, post: row.archiveSlug }) }));
	const markup = renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Garden", slug: user.slug, signupFields: [] }, readers: 1 }, page));
	assert.match(markup, /<h1 class="sr-only">Short post<\/h1>/); assert.match(markup, /<strong>garden<\/strong>/);
	const { xml } = m.feed.buildFeed({ newsletter, issues: [issue] }); const item = xml.match(/<item>[\s\S]*?<\/item>/)[0];
	assert.doesNotMatch(item, /<title>/); assert.match(item, /content:encoded/); assert.match(item, /garden/);
	assert.equal(m.markdown.getArchiveMarkdown(issue).startsWith("# "), false);
});

test("short post schedules reuse campaign jobs and publish without delivery messages", async () => {
	const user = await publisher(); const made = await draft(user, "Tomorrow's web observation.");
	const future = new Date(Date.now() + 120000).toISOString();
	const scheduled = await api(user, "POST", `/campaigns/${made.body.id}/schedule`, { scheduledAt: future }); assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
	assert.equal(scheduled.body.status, "scheduled"); assert.ok(published.some(({ url, body }) => url.endsWith("/send-scheduled") && body.campaignId === made.body.id));
	const past = new Date(Date.now() - 10000);
	await m.Campaign.updateOne({ accountId: user.accountId, _id: made.body.id }, { $set: { scheduledAt: past } });
	await m.scheduling.runScheduledSend({ accountId: user.accountId, campaignId: made.body.id, scheduledAt: past.toISOString() });
	assert.equal((await stored(user, made.body.id)).status, "sent");
	assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: made.body.id }), 0);
});

test("body edits and version restores preserve note type, public address and original date", async () => {
	const user = await publisher(); const made = await draft(user, "Original note."); await send(user, made.body.id);
	const original = await stored(user, made.body.id);
	assert.equal((await api(user, "PATCH", `/campaigns/${made.body.id}/published`, { content: "Revised note.", format: "markdown" })).status, 200);
	let row = await stored(user, made.body.id); assert.equal(row.subject, "Revised note."); assert.equal(row.kind, "note"); assert.equal(row.archiveSlug, original.archiveSlug); assert.equal(+row.sentAt, +original.sentAt);
	assert.equal((await api(user, "PATCH", `/campaigns/${made.body.id}/published`, { title: "Manual title" })).status, 400);
	const version = await m.CampaignVersion.findOne({ accountId: user.accountId, campaignId: made.body.id }).sort({ _id: 1 }).lean();
	assert.equal((await api(user, "POST", `/campaigns/${made.body.id}/versions/${version._id}/restore`, {})).status, 200);
	row = await stored(user, made.body.id); assert.equal(row.markdown, "Original note."); assert.equal(row.subject, "Original note."); assert.equal(row.publishTo, "web");
	const exported = m.exports.buildCampaignFiles({ campaign: row, newsletter: user.newsletter, images: new Map() });
	assert.equal(exported.meta.kind, "note"); assert.match(exported.markdown.text, /kind: "note"/);
});

test("a reviewed weekly digest includes only own public listed posts and is a retry-safe email draft", async () => {
	const user = await publisher(), other = await publisher();
	const first = await draft(user, "First public note."); await send(user, first.body.id);
	const second = await draft(user, "Second public note."); await send(user, second.body.id);
	const hidden = await draft(user, "Unlisted private-link note."); await send(user, hidden.body.id);
	await m.Campaign.updateOne({ accountId: user.accountId, _id: hidden.body.id }, { $set: { archiveListed: false } });
	const old = await draft(user, "An old note."); await send(user, old.body.id);
	await m.Campaign.updateOne({ accountId: user.accountId, _id: old.body.id }, { $set: { sentAt: new Date(Date.now() - 9 * 86400000) } });
	await draft(user, "Unpublished draft.");
	const foreign = await draft(other, "Foreign account note."); await send(other, foreign.body.id);
	const emails = platformEmails.length, jobs = published.length;
	const requests = await Promise.all([api(user, "POST", "/short-posts/digest", { newsletter: user.slug, externalId: "weekly-digest" }), api(user, "POST", "/short-posts/digest", { newsletter: user.slug, externalId: "weekly-digest" })]);
	for (const response of requests) assert.equal(response.status, 201, JSON.stringify(response.body));
	assert.equal(requests[0].body.id, requests[1].body.id); assert.deepEqual(requests[0].body.noteIds, [first.body.id, second.body.id]);
	const digest = await stored(user, requests[0].body.id); assert.equal(digest.kind, "issue"); assert.equal(digest.publishTo, "both"); assert.equal(digest.status, "draft");
	assert.match(digest.html, /First public note/); assert.match(digest.html, /Second public note/); assert.doesNotMatch(digest.html, /Foreign account|Unlisted private|An old note|Unpublished draft/);
	assert.equal(platformEmails.length, emails); assert.equal(published.length, jobs);
	const exported = m.exports.buildCampaignFiles({ campaign: digest, newsletter: user.newsletter, images: new Map() }); assert.deepEqual(exported.meta.shortPostDigest.noteIds, [first.body.id, second.body.id]);
});

test("empty or oversized digest windows are refused and public notes cannot introduce gated blocks into a digest", async () => {
	const user = await publisher(); assert.equal((await api(user, "POST", "/short-posts/digest", { newsletter: user.slug, externalId: "empty" })).status, 400);
	await m.Campaign.insertMany(Array.from({ length: 21 }, (_, index) => ({ accountId: user.accountId, newsletterId: user.newsletterId, kind: "note", status: "sent", publishTo: "web", audience: "all", archiveSlug: `many-${index}`, format: "markdown", markdown: "Small note.", sentAt: new Date() })));
	assert.equal((await api(user, "POST", "/short-posts/digest", { newsletter: user.slug, externalId: "too-many" })).status, 400);
	const single = await publisher(); const made = await draft(single, "A valid note."); await send(single, made.body.id);
	await m.Campaign.updateOne({ accountId: single.accountId, _id: made.body.id }, { $set: { format: "rich", html: '<div data-access="paid">Private source fixture</div>' } });
	assert.equal((await api(single, "POST", "/short-posts/digest", { newsletter: single.slug, externalId: "corrupt" })).status, 400);
});

test("draft-only agents may prepare notes and digests, but publishing needs send permission and owner approval", async () => {
	const user = await publisher(), foreign = await publisher();
	const key = async (level) => (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Short post agent", level })))).key;
	const original = user.key; user.key = await key("drafts");
	const made = await draft(user, "Prepared by a draft-only agent."); assert.equal(made.status, 201);
	assert.equal((await send(user, made.body.id)).status, 403);
	user.key = await key("send_with_approval"); assert.equal((await send(user, made.body.id)).status, 202); assert.equal((await stored(user, made.body.id)).status, "draft");
	assert.equal((await api(foreign, "PATCH", `/campaigns/${made.body.id}`, { content: "Foreign edit." })).status, 404);
	user.key = original; assert.equal((await send(user, made.body.id)).status, 200);
	user.key = await key("drafts"); assert.equal((await api(user, "POST", "/short-posts/digest", { newsletter: user.slug, externalId: "agent-digest" })).status, 201);
});

test("concurrent retry keys keep one short-post draft and excerpts decode punctuation without becoming a headline", async () => {
	const user = await publisher();
	const results = await Promise.all([draft(user, "Tomorrow's <garden> & observations.", { externalId: "same-note" }), draft(user, "Tomorrow's <garden> & observations.", { externalId: "same-note" })]);
	for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.body));
	assert.equal(results[0].body.id, results[1].body.id);
	assert.ok(results[0].body.subject.includes("Tomorrow's")); assert.ok(!results[0].body.subject.includes("&#39;"));
	assert.equal((await api(user, "POST", "/campaigns", { newsletter: user.slug, externalId: "same-note", subject: "An issue" })).status, 409);
	const blank = await draft(user, ""); assert.equal(blank.status, 201); assert.equal((await send(user, blank.body.id)).status, 422);
});
