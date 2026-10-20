import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, catchRedirect, startTestApp } from "./helpers/app.mjs";
import { readFixture, serveFeeds } from "./helpers/feeds.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, setupSender } from "./helpers/sending.mjs";

// beehiiv parity W6: saved issue templates, snippets for the editor and a default style per newsletter.

let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = {
		...(await loadSendingModules()),
		templateActions: await import("../app/(app)/templates/actions.js"),
		templatesPage: await import("../app/(app)/templates/page.js"),
		campaignsPage: await import("../app/(app)/campaigns/(list)/page.js"),
		IssueTemplate: (await import("../models/IssueTemplate.js")).default,
		Snippet: (await import("../models/Snippet.js")).default,
		series: await import("../lib/series.js"),
		SeriesPlan: (await import("../models/SeriesPlan.js")).default,
		templates: await import("../lib/templates.js"),
		richText: await import("../lib/rich-text.js"),
	};
});

after(() => app?.stop());

describe("issue templates", () => {
	let user;
	let other;

	before(async () => {
		user = await setupSender(m, "templates-owner@example.com", { contacts: 1 });
		other = await setupSender(m, "templates-other@example.com", { contacts: 1 });
	});

	test("any issue, a draft or a sent one, is saved as it is, and the lists leave out the content", async () => {
		const draftId = await createDraft(m, user, { subject: "Weekly letter", previewText: "What happened", body: "<p>Hello <strong>there</strong></p>" });
		const fromDraft = await act(m, user, "create_template", { name: "Weekly", campaign: draftId });
		assert.deepEqual([fromDraft.name, fromDraft.subject, fromDraft.previewText, fromDraft.format, fromDraft.content], ["Weekly", "Weekly letter", "What happened", "rich", "<p>Hello <strong>there</strong></p>"]);

		const sentId = await createDraft(m, user, { subject: "Already sent", body: "<p>Gone out</p>" });
		await act(m, user, "send_campaign", { id: sentId });
		const fromSent = await act(m, user, "create_template", { name: "From a sent issue", campaign: sentId, subject: "A new subject" });
		assert.deepEqual([fromSent.subject, fromSent.content], ["A new subject", "<p>Gone out</p>"]);

		const markdown = await act(m, user, "create_template", { name: "Markdown one", subject: "MD", content: "# Title\n\nBody" });
		assert.deepEqual([markdown.format, markdown.content], ["markdown", "# Title\n\nBody"]);
		const empty = await act(m, user, "create_template", { name: "Empty" });
		assert.deepEqual([empty.format, empty.content], ["rich", ""]);

		const { templates } = await act(m, user, "list_templates", {});
		assert.deepEqual(templates.map(({ name }) => name), ["Empty", "From a sent issue", "Markdown one", "Weekly"]);
		assert.ok(templates.every((template) => !("content" in template)));
		assert.equal((await act(m, user, "get_template", { id: fromDraft.id })).content, "<p>Hello <strong>there</strong></p>");
		await assert.rejects(act(m, user, "create_template", { name: "Nope", campaign: "6650f1c2e9b1d4a012345678" }), { code: "not_found" });
	});

	test("renamed, edited and deleted, and never reachable from another account", async () => {
		const template = await act(m, user, "create_template", { name: "Old name", content: "<p>Old</p>", format: "rich" });
		const renamed = await act(m, user, "update_template", { id: template.id, name: "New name" });
		assert.deepEqual([renamed.name, renamed.content], ["New name", "<p>Old</p>"]);
		const edited = await act(m, user, "update_template", { id: template.id, subject: "S", content: "<p>New</p>" });
		assert.deepEqual([edited.subject, edited.content, edited.format], ["S", "<p>New</p>", "rich"]);
		await assert.rejects(act(m, user, "update_template", { id: template.id, format: "html" }), { code: "validation_failed" });

		await assert.rejects(act(m, other, "get_template", { id: template.id }), { code: "not_found" });
		await assert.rejects(act(m, other, "update_template", { id: template.id, name: "Mine" }), { code: "not_found" });
		await assert.rejects(act(m, other, "delete_template", { id: template.id }), { code: "not_found" });
		assert.deepEqual((await act(m, other, "list_templates", {})).templates, []);

		assert.deepEqual(await act(m, user, "delete_template", { id: template.id }), { id: template.id, deleted: true });
		await assert.rejects(act(m, user, "get_template", { id: template.id }), { code: "not_found" });
	});

	test("a new issue starts from a template with its subject, preview text and content, and what is passed replaces them", async () => {
		const template = await act(m, user, "create_template", { name: "Starter", subject: "Template subject", previewText: "Template preview", format: "rich", content: '<p>From the template</p><img src="https://cdn.example.com/hero.jpg" alt="">' });
		const campaign = await act(m, user, "create_campaign", { template: template.id });
		assert.deepEqual([campaign.subject, campaign.previewText, campaign.format, campaign.content, campaign.status], ["Template subject", "Template preview", "rich", template.content, "draft"]);
		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: campaign.id }).lean();
		assert.equal(stored.thumbnailUrl, "https://cdn.example.com/hero.jpg");

		const changed = await act(m, user, "create_campaign", { template: template.id, subject: "Mine", content: "Own **words**", format: "markdown" });
		assert.deepEqual([changed.subject, changed.previewText, changed.format, changed.content], ["Mine", "Template preview", "markdown", "Own **words**"]);

		await assert.rejects(act(m, user, "create_campaign", { template: "6650f1c2e9b1d4a012345678" }), { code: "not_found" });
		await assert.rejects(act(m, other, "create_campaign", { template: template.id }), { code: "not_found" });
		const second = await m.Newsletter.create({ accountId: user.accountId, name: "Second", slug: "templates-second", fromEmail: "hello@templates-second.flockstackmail.com" });
		await assert.rejects(act(m, user, "create_campaign", { newsletter: String(second._id), template: template.id }), { code: "validation_failed", message: /another newsletter/ });
	});

	test("a newsletter has 50 at most", async () => {
		const crowded = await setupSender(m, "templates-crowded@example.com", { contacts: 1 });
		await m.IssueTemplate.insertMany(Array.from({ length: 50 }, (_, index) => ({ accountId: crowded.accountId, newsletterId: crowded.newsletterId, name: `T${index}` })));
		await assert.rejects(act(m, crowded, "create_template", { name: "One more" }), { code: "conflict" });
	});
});

describe("snippets", () => {
	let user;

	before(async () => {
		user = await setupSender(m, "snippets-owner@example.com", { contacts: 1 });
	});

	test("kept as cleaned content, from plain paragraphs or HTML, and changed, listed and deleted", async () => {
		const plain = await act(m, user, "create_snippet", { name: "Sign-off", content: "Thanks for reading.\n\nSee you next week & more." });
		assert.equal(plain.content, "<p>Thanks for reading.</p><p>See you next week &amp; more.</p>");
		const html = await act(m, user, "create_snippet", { name: "Sponsor", content: '<p>Brought to you by <a href="https://example.com" onclick="x()">Example</a></p><script>alert(1)</script>' });
		assert.equal(html.content, '<p>Brought to you by <a href="https://example.com">Example</a></p>');

		await assert.rejects(act(m, user, "create_snippet", { name: "Empty", content: "   " }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "create_snippet", { name: "Script only", content: "<script>alert(1)</script>" }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "create_snippet", { name: "Huge", content: "x".repeat(20_001) }), { code: "validation_failed" });

		const renamed = await act(m, user, "update_snippet", { id: plain.id, name: "Signature", content: "Cheers" });
		assert.deepEqual([renamed.name, renamed.content], ["Signature", "<p>Cheers</p>"]);
		assert.deepEqual((await act(m, user, "list_snippets", {})).snippets.map(({ name }) => name), ["Signature", "Sponsor"]);
		assert.deepEqual(await act(m, user, "delete_snippet", { id: html.id }), { id: html.id, deleted: true });
		assert.deepEqual((await act(m, user, "list_snippets", {})).snippets.map(({ name }) => name), ["Signature"]);

		const other = await setupSender(m, "snippets-other@example.com", { contacts: 1 });
		await assert.rejects(act(m, other, "update_snippet", { id: plain.id, name: "Mine" }), { code: "not_found" });
		assert.deepEqual((await act(m, other, "list_snippets", {})).snippets, []);
	});

	test("a newsletter has 50 at most", async () => {
		const crowded = await setupSender(m, "snippets-crowded@example.com", { contacts: 1 });
		await m.Snippet.insertMany(Array.from({ length: 50 }, (_, index) => ({ accountId: crowded.accountId, newsletterId: crowded.newsletterId, name: `S${index}`, html: "<p>x</p>" })));
		await assert.rejects(act(m, crowded, "create_snippet", { name: "One more", content: "x" }), { code: "conflict" });
	});
});

describe("the default style", () => {
	let user;
	const BLOG = "https://blog.example.com/style.xml";

	before(async () => {
		user = await setupSender(m, "style-owner@example.com", { contacts: 1 });
	});

	test("is a header and a footer around the empty place a new issue starts, set with update_newsletter and cleaned", async () => {
		const blank = await act(m, user, "create_campaign", {});
		assert.equal(blank.content, "", "no style, an empty issue as before");

		const saved = await act(m, user, "update_newsletter", { id: user.newsletterId, defaultStyle: { header: "Hello, friend.", footer: '<p>Unsubscribe any time.</p><script>x()</script>' }, accentColor: "#1F6FEB" });
		assert.deepEqual(saved.defaultStyle, { header: "<p>Hello, friend.</p>", footer: "<p>Unsubscribe any time.</p>" });
		assert.equal(saved.accentColor, "#1f6feb");

		const onlyHeader = await act(m, user, "update_newsletter", { id: user.newsletterId, defaultStyle: { header: "<h2>Dear reader</h2>" } });
		assert.deepEqual(onlyHeader.defaultStyle, { header: "<h2>Dear reader</h2>", footer: "<p>Unsubscribe any time.</p>" }, "the footer stays");
		await assert.rejects(act(m, user, "update_newsletter", { id: user.newsletterId, defaultStyle: { footer: "x".repeat(20_001) } }), { code: "validation_failed" });
		assert.equal((await act(m, user, "get_newsletter", { id: user.newsletterId })).defaultStyle.header, "<h2>Dear reader</h2>");
	});

	test("goes into new issues as content, but not into one that has content, a template or another format", async () => {
		const started = await act(m, user, "create_campaign", {});
		assert.equal(started.content, "<h2>Dear reader</h2><p></p><p>Unsubscribe any time.</p>");
		assert.equal(started.format, "rich");
		assert.equal((await act(m, user, "create_campaign", { content: "# Own", format: "markdown" })).content, "# Own");
		assert.equal((await act(m, user, "create_campaign", { format: "markdown" })).content, "");
		const template = await act(m, user, "create_template", { name: "Bare", content: "<p>Bare</p>", format: "rich" });
		assert.equal((await act(m, user, "create_campaign", { template: template.id })).content, "<p>Bare</p>");
	});

	test("also frames the issues a series makes", async () => {
		const served = serveFeeds(new Map([[BLOG, readFixture("blog.rss.xml")]]));
		try {
			const series = await act(m, user, "create_series", { name: "Styled", feedUrl: BLOG, subject: "{{first_title}}", count: 1, intro: "Intro line" });
			const run = await act(m, user, "run_series", { id: series.id });
			const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: run.campaignId }).lean();
			assert.match(campaign.html, /^<h2>Dear reader<\/h2><p>Intro line<\/p><img [^>]*><h3>/);
			assert.match(campaign.html, /<p>Unsubscribe any time\.<\/p>$/);
		} finally {
			served.restore();
		}
	});

	test("plain paragraphs and HTML go to and from the text boxes", () => {
		assert.equal(m.richText.textToRich("One\n\nTwo & three\nfour"), "<p>One</p><p>Two &amp; three<br>four</p>");
		assert.equal(m.richText.textToRich("<p>Already</p>"), "<p>Already</p>");
		assert.equal(m.richText.textToRich("  "), "");
		assert.equal(m.richText.richToText("<p>One</p><p>Two &amp; three<br>four</p>"), "One\n\nTwo & three\nfour");
		assert.equal(m.richText.richToText("<h2>Title</h2><p>x</p>"), "<h2>Title</h2><p>x</p>");
		assert.equal(m.templates.getStartingHtml({ defaultStyle: { header: "<p>H</p>" } }), "<p>H</p><p></p>");
		assert.equal(m.templates.getStartingHtml({}), "");
		assert.equal(m.templates.withDefaultStyle({ defaultStyle: { header: "<p>H</p>", footer: "<p>F</p>" } }, "<p>B</p>"), "<p>H</p><p>B</p><p>F</p>");
	});
});

describe("the dashboard", () => {
	test("saves an issue as a template, starts a new one from it, and keeps snippets and the style on its page", async () => {
		const user = await setupSender(m, "templates-dashboard@example.com", { contacts: 1 });
		const campaignId = await createDraft(m, user, { subject: "Dashboard letter", body: "<p>Dashboard body</p>" });

		assert.equal((await as(user, () => m.campaigns.saveCampaignAsTemplate(campaignId, ""))).error, "name: Too small: expected string to have >=1 characters");
		const saved = await as(user, () => m.campaigns.saveCampaignAsTemplate(campaignId, "Dashboard template"));
		assert.equal(saved.template.name, "Dashboard template");

		assert.equal((await as(user, () => m.templateActions.saveSnippet(user.newsletterId, "", { name: "Dash snippet", content: "Snippet body" }))).ok, true);
		assert.equal((await as(user, () => m.templateActions.saveDefaultStyle(user.newsletterId, { header: "Header words", footer: "", accentColor: "#112233" }))).ok, true);

		const page = renderToStaticMarkup(await as(user, () => m.templatesPage.default()));
		for (const text of ["Dashboard template", "Dashboard letter", "Dash snippet", "Snippet body", "Header words"]) assert.match(page, new RegExp(text));
		assert.match(page, /#112233/);

		const list = renderToStaticMarkup(await as(user, () => m.campaignsPage.default()));
		assert.match(list, /New/);

		const started = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId, saved.template.id)));
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: started.split("/").at(-1) }).lean();
		assert.deepEqual([campaign.subject, campaign.html], ["Dashboard letter", "<p>Dashboard body</p>"]);
		const blank = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: blank.split("/").at(-1) }).lean()).html, "<p>Header words</p><p></p>");

		const [template] = (await act(m, user, "list_templates", {})).templates;
		assert.equal((await as(user, () => m.templateActions.renameTemplate(template.id, "Renamed"))).ok, true);
		assert.equal((await act(m, user, "get_template", { id: template.id })).name, "Renamed");
		assert.equal((await as(user, () => m.templateActions.deleteTemplate(template.id))).ok, true);
		const [snippet] = (await act(m, user, "list_snippets", {})).snippets;
		assert.equal((await as(user, () => m.templateActions.saveSnippet(user.newsletterId, snippet.id, { name: "Edited", content: "New body" }))).ok, true);
		assert.equal((await as(user, () => m.templateActions.deleteSnippet(snippet.id))).ok, true);
		assert.deepEqual((await act(m, user, "list_snippets", {})).snippets, []);
	});
});
