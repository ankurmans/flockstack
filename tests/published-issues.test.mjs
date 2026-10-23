import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addIssue, addReader, createPublisher, importModels } from "./helpers/community.mjs";
import { as, callApi, catchRedirect, form, startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";
import { revalidatedPaths } from "./stubs/next-cache.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// update_published_issue: the web page of a sent issue changes, and nothing that went out or was counted does.
let app;
let m;
let counter = 0;

const text = (markup) => markup.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		...(await importModels()),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		editPage: (await import("../app/(app)/campaigns/[id]/edit/page.js")).default,
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		feedRoute: await import("../app/archive/[slug]/feed/route.js"),
		sitemapRoute: await import("../app/archive/[slug]/sitemap/route.js"),
		CampaignVersion: (await import("../models/CampaignVersion.js")).default,
	};
});

after(() => app?.stop());

async function publisher(issue = {}) {
	const user = await createPublisher(m, `edit${++counter}@example.com`, { issue: { subject: "Original title", previewText: "Original subtitle", html: "<p>Original words.</p>", stats: { recipients: 3, sent: 3, delivered: 3, opened: 2, clicked: 1 }, ...issue } });
	await addReader(m, user, `reader@edit${counter}.example.org`);
	return user;
}

const patch = (user, id, body, key = user.key) => callApi("PATCH", `/api/v1/campaigns/${id}/published`, { key, body });
const campaignOf = (user, id) => m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();

describe("editing a sent issue's web page", () => {
	test("changes the title, subtitle, body, tags and search settings of the page, and the page shows them", async () => {
		const user = await publisher();
		const id = String(user.issue._id);
		const response = await patch(user, id, {
			title: "Corrected title",
			subtitle: "Corrected subtitle",
			content: '<p>Corrected words.</p><img src="https://img.example.org/new.png" alt="New">',
			format: "rich",
			tags: ["Corrections"],
			seoTitle: "Search title",
			seoDescription: "Search description",
			noindex: true,
		});
		assert.equal(response.status, 200, JSON.stringify(response.body));
		assert.equal(response.body.status, "sent");
		assert.equal(response.body.subject, "Corrected title");
		assert.deepEqual(response.body.tags, ["corrections"]);
		assert.equal(response.body.seo.title, "Search title");
		assert.equal(response.body.seo.noindex, true);

		const stored = await campaignOf(user, id);
		assert.equal(stored.previewText, "Corrected subtitle");
		assert.equal(stored.thumbnailUrl, "https://img.example.org/new.png");
		assert.equal(stored.archiveSlug, user.issue.archiveSlug, "the page keeps its address");
		const { default: ProviderSubscribe } = await import("../components/ProviderSubscribe.jsx");
		const pitch = { name: "n", slug: user.slug, imageUrl: "", description: "", signupFields: [] };
		const element = await m.issuePage({ params: Promise.resolve({ slug: user.slug, post: stored.archiveSlug }) });
		const page = text(renderToStaticMarkup(createElement(ProviderSubscribe, { newsletter: pitch, readers: 0 }, element)));
		assert.match(page, /Corrected title/);
		assert.match(page, /Corrected words\./);
		assert.doesNotMatch(page, /Original words\./);
	});

	test("touches nothing that went out: stats, audience, status, dates, messages, emails", async () => {
		const user = await publisher();
		const id = String(user.issue._id);
		const reader = await m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId }).lean();
		await m.Message.create({ accountId: user.accountId, campaignId: id, newsletterId: user.newsletterId, contactId: reader._id, email: reader.email, kind: "campaign", status: "delivered" });
		const messages = async () => (await m.Message.find({ accountId: user.accountId, campaignId: id }).lean()).map((message) => JSON.stringify(message));
		const before = await campaignOf(user, id);
		const messagesBefore = await messages();
		const emails = sesEmails.length;
		const jobs = published.length;

		assert.equal((await patch(user, id, { title: "New title", content: "<p>New</p>", format: "rich" })).status, 200);

		const after = await campaignOf(user, id);
		for (const field of ["stats", "status", "audience", "audienceLimit", "segmentId", "sentAt", "startedAt", "finishedAt", "archiveSlug", "archiveListed", "publishTo", "lastChance", "abTest", "scheduledAt"]) {
			assert.deepEqual(after[field], before[field], field);
		}
		assert.deepEqual(await messages(), messagesBefore, "the message records");
		assert.equal(sesEmails.length, emails, "no email goes out");
		assert.equal(published.length, jobs, "no job is queued");
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean()).status, "active");
	});

	test("refreshes the website's cached pages and moves the page's modified date, but not its place in the list or the feed", async () => {
		const user = await publisher({ sentAt: new Date("2026-03-01T10:00:00Z") });
		const id = String(user.issue._id);
		const before = revalidatedPaths.length;
		const feed = async () => (await (await m.feedRoute.GET(new Request(`http://localhost:3000/archive/${user.slug}/feed.xml`), { params: Promise.resolve({ slug: user.slug }) })).text());
		const feedBefore = await feed();
		assert.match(feedBefore, /<pubDate>Sun, 01 Mar 2026 10:00:00 GMT<\/pubDate>/);

		await patch(user, id, { title: "Updated", content: "<p>Updated words.</p>", format: "rich" });
		assert.ok(revalidatedPaths.slice(before).some(([path, type]) => path === "/archive/[slug]" && type === "layout"));
		const feedAfter = await feed();
		assert.match(feedAfter, /<pubDate>Sun, 01 Mar 2026 10:00:00 GMT<\/pubDate>/, "the original date stays");
		assert.equal(feedAfter.match(/<guid[^>]*>([^<]*)<\/guid>/)[1], feedBefore.match(/<guid[^>]*>([^<]*)<\/guid>/)[1], "the same entry");
		assert.match(feedAfter, /<title>Updated<\/title>/);
		assert.match(feedAfter, /Updated words\./);
		assert.doesNotMatch(feedAfter, /Original words\./);

		const sitemap = await (await m.sitemapRoute.GET(new Request(`http://localhost:3000/archive/${user.slug}/sitemap.xml`), { params: Promise.resolve({ slug: user.slug }) })).text();
		const lastmod = new Date(sitemap.match(/<lastmod>([^<]+)<\/lastmod>/)[1]).getTime();
		assert.ok(Math.abs(lastmod - Date.now()) < 60_000, "the sitemap says it changed now");
	});

	test("keeps the page as it was in the version history, 30 at most, and can put one back", async () => {
		const user = await publisher();
		const id = String(user.issue._id);
		await patch(user, id, { title: "Second title", content: "<p>Second words.</p>", format: "rich" });
		const listed = await callApi("GET", `/api/v1/campaigns/${id}/versions`, { key: user.key });
		assert.equal(listed.body.versions.length, 1);
		assert.equal(listed.body.versions[0].reason, "edit");
		assert.equal(listed.body.versions[0].subject, "Original title");
		assert.match(listed.body.versions[0].excerpt, /Original words\./);

		const restored = await as(user, () => m.campaigns.restoreCampaignVersion(id, listed.body.versions[0].id));
		assert.deepEqual(restored, { ok: true });
		assert.equal((await campaignOf(user, id)).subject, "Original title");
		assert.match((await campaignOf(user, id)).html, /Original words\./);
		assert.equal((await campaignOf(user, id)).status, "sent");
		const kept = await callApi("GET", `/api/v1/campaigns/${id}/versions`, { key: user.key });
		assert.deepEqual(kept.body.versions.map(({ reason }) => reason), ["restore", "edit"], "the page before the restore is kept too");

		for (let edit = 0; edit < 34; edit++) await patch(user, id, { content: `<p>Edit number ${edit}.</p>`, format: "rich" });
		assert.equal(await m.CampaignVersion.countDocuments({ accountId: user.accountId, campaignId: id }), 30);
	});

	test("an edit that changes nothing keeps no version, and tags or search settings alone keep none", async () => {
		const user = await publisher();
		const id = String(user.issue._id);
		await patch(user, id, { title: "Original title", content: "<p>Original words.</p>", format: "rich" });
		await patch(user, id, { tags: ["only-tags"], seoTitle: "Only search" });
		assert.equal(await m.CampaignVersion.countDocuments({ accountId: user.accountId, campaignId: id }), 0);
		assert.deepEqual((await campaignOf(user, id)).tags, ["only-tags"]);
		assert.equal((await campaignOf(user, id)).seo.title, "Only search");
	});

	test("refuses what isn't a finished send with a page, and an empty title, and changes nothing when it does", async () => {
		const user = await publisher();
		const draft = await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Draft", status: "draft", html: "<p>Draft</p>" });
		const sending = await addIssue(m, user, { status: "sending" });
		const paused = await addIssue(m, user, { status: "paused" });
		const emailOnly = await addIssue(m, user, { publishTo: "email" });
		const resend = await addIssue(m, user, { resend: { of: user.issue._id, to: "unopened" } });
		const testing = await addIssue(m, user, { abTest: { status: "testing" } });
		for (const campaign of [draft, sending, paused, emailOnly, resend, testing]) {
			const response = await patch(user, String(campaign._id), { title: "Nope" });
			assert.equal(response.status, 409, `${campaign.status} ${JSON.stringify(campaign.publishTo ?? "")}: ${JSON.stringify(response.body)}`);
			assert.notEqual((await campaignOf(user, campaign._id)).subject, "Nope");
		}
		const id = String(user.issue._id);
		assert.equal((await patch(user, id, { title: "   " })).status, 400);
		assert.equal((await patch(user, id, { format: "html" })).status, 400, "a format needs content");
		const invalidSeo = await patch(user, id, { title: "Half done", socialImage: "http://not-https.example.org/x.png" });
		assert.equal(invalidSeo.status, 400);
		assert.equal((await campaignOf(user, id)).subject, "Original title", "a refused edit is all or nothing");
		assert.equal((await patch(user, "000000000000000000000000", { title: "x" })).status, 404);
	});

	test("update_campaign still refuses a sent issue, and says where the page is changed", async () => {
		const user = await publisher();
		const response = await callApi("PATCH", `/api/v1/campaigns/${user.issue._id}`, { key: user.key, body: { subject: "Changed" } });
		assert.equal(response.status, 409);
		assert.match(response.body.error.message, /Only drafts can be edited: a sent issue's web page changes with update_published_issue/);
	});
});

describe("who may edit a sent issue's page", () => {
	test("it is a write action: a send with approval key does it without asking, a drafts or read only key can't", async () => {
		const { getActionClass, NEWSLETTER_APPROVAL_CLASSES } = await import("../lib/action-scopes.js");
		assert.equal(getActionClass("update_published_issue"), "write");
		assert.ok(!NEWSLETTER_APPROVAL_CLASSES.includes("write"), "not a send");
		const user = await publisher();
		const id = String(user.issue._id);
		const keyOf = async (level) => (await as(user, () => m.apiKeys.createApiKey(null, form({ name: level, level })))).key;
		assert.equal((await patch(user, id, { title: "By a drafts key" }, await keyOf("drafts"))).status, 403);
		assert.equal((await patch(user, id, { title: "By a read only key" }, await keyOf("read_only"))).status, 403);
		const allowed = await patch(user, id, { title: "By a send with approval key" }, await keyOf("send_with_approval"));
		assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
		assert.equal(allowed.body.subject, "By a send with approval key");
	});

	test("a newsletter that asks before an agent sends doesn't hold an edit of a page back", async () => {
		const user = await publisher();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { agentApproval: true } });
		const response = await patch(user, String(user.issue._id), { title: "Still direct" });
		assert.equal(response.status, 200);
	});
});

describe("the editor for a sent issue", () => {
	async function render(user, id) {
		const element = await as(user, () => m.editPage({ params: Promise.resolve({ id }) }));
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		return renderToStaticMarkup(createElement(TooltipProvider, null, element));
	}

	test("says the emails are not changed, and has the fields of the page", async () => {
		const user = await publisher({ tags: ["news"], tagSlugs: ["news"] });
		const html = await render(user, String(user.issue._id));
		assert.match(text(html), /Emails already sent are not changed\./);
		assert.match(html, /value="Original title"/);
		assert.match(html, /value="Original subtitle"/);
		assert.match(html, /value="news"/);
		assert.match(text(html), /Edit web version/);
		assert.match(html, /History/);
		assert.match(html, /View page/);
	});

	test("sends a draft, an email only issue and a campaign that is still going out back to the campaign", async () => {
		const user = await publisher();
		const draft = await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Draft", status: "draft", html: "<p>Draft</p>" });
		const emailOnly = await addIssue(m, user, { publishTo: "email" });
		const sending = await addIssue(m, user, { status: "sending" });
		for (const campaign of [draft, emailOnly, sending]) {
			const url = await as(user, () => catchRedirect(m.editPage({ params: Promise.resolve({ id: String(campaign._id) }) })));
			assert.equal(url, `/campaigns/${campaign._id}`);
		}
	});

	test("the report of a sent issue links to it, and a draft's page doesn't", async () => {
		const { default: CampaignReport } = await import("../components/CampaignReport.jsx");
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const user = await publisher();
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const markup = (campaign) =>
			renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CampaignReport, { campaign: JSON.parse(JSON.stringify(campaign)), newsletter: JSON.parse(JSON.stringify(newsletter)), providers: [] })));
		assert.match(markup(user.issue), new RegExp(`href="/campaigns/${user.issue._id}/edit"`));
		assert.doesNotMatch(markup({ ...user.issue, publishTo: "email" }), /\/edit"/);
	});
});
