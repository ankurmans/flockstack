import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, anonymous, as, callApi, catchNotFound, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// A newsletter whose first issue hasn't gone out: its home page is a calm page with the signup form instead of a 404, kept out
// of search engines, with no empty list of issues. Switched off, or waiting for its deletion, it stays a 404.
let app;
let m;

async function customer(email) {
	const user = await signIn(email);
	await activate(user);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

async function createNewsletter(user, body) {
	const response = await callApi("POST", "/api/v1/newsletters", { key: user.key, body });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

const params = (slug, more = {}) => ({ params: Promise.resolve({ slug, ...more }) });
const text = (markup) => markup.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// The page as a visitor gets it: the layout around it, with the page inside.
async function visit(slug) {
	const page = await anonymous(() => m.homePage(params(slug)));
	const layout = await anonymous(() => m.layout({ ...params(slug), children: page }));
	return renderToStaticMarkup(createElement(m.TooltipProvider, null, layout));
}

before(async () => {
	app = await startTestApp();
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		homePage: (await import("../app/archive/[slug]/page.js")).default,
		homeMetadata: (await import("../app/archive/[slug]/page.js")).generateMetadata,
		layout: (await import("../app/archive/[slug]/layout.js")).default,
		issuesPage: (await import("../app/archive/[slug]/issues/page.js")).default,
		feedRoute: await import("../app/archive/[slug]/feed/route.js"),
		sitemapRoute: await import("../app/archive/[slug]/sitemap/route.js"),
		llmsRoute: await import("../app/archive/[slug]/llms/route.js"),
		archiveData: await import("../lib/archive-data.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
	};
});

after(() => app?.stop());

describe("the page before the first issue", () => {
	test("shows the name, logo, description, the words and the signup form, in the newsletter's brand", async () => {
		const user = await customer("soon-page@example.com");
		const created = await createNewsletter(user, {
			name: "Quiet Fridays",
			description: "One calm idea a week.",
			imageUrl: "https://img.example.org/logo.png",
			brand: { theme: "magazine" },
			socialLinks: ["https://example.org/quietfridays"],
		});
		const markup = await visit(created.slug);
		const words = text(markup);
		assert.match(words, /Quiet Fridays/);
		assert.match(words, /One calm idea a week\./);
		assert.match(words, /First issue coming soon/);
		assert.match(markup, /<form[^>]*>[\s\S]*name="email"/, "the signup form");
		assert.match(markup, /logo\.png/);
		assert.match(markup, /data-site-theme="magazine"/);
		assert.match(markup, /href="https:\/\/example\.org\/quietfridays"/);
	});

	test("has no empty list of issues, no feed to follow, no navigation and no structured data", async () => {
		const user = await customer("soon-empty@example.com");
		const created = await createNewsletter(user, { name: "Empty Mondays" });
		const markup = await visit(created.slug);
		const words = text(markup);
		assert.doesNotMatch(words, /Latest issue|Recent issues|All issues|Featured|Search and tags/);
		assert.doesNotMatch(markup, /RSS feed|application\/rss\+xml/);
		assert.doesNotMatch(markup, /application\/ld\+json/);
		assert.doesNotMatch(markup, /href="[^"]*\/(issues|feed\.xml|shop)"/);
	});

	test("asks search engines to wait, and has no share card or feed in its head", async () => {
		const user = await customer("soon-seo@example.com");
		const created = await createNewsletter(user, { name: "Unseen Notes", description: "Not yet." });
		const metadata = await m.homeMetadata(params(created.slug));
		assert.deepEqual(metadata.robots, { index: false, follow: false });
		assert.equal(metadata.title.absolute, "Unseen Notes");
		assert.equal(metadata.description, "Not yet.");
		assert.equal(metadata.openGraph.images, undefined, "the share card is made from an issue");
		assert.equal(metadata.alternates.types, undefined);
	});

	test("takes signups as it always did", async () => {
		const user = await customer("soon-signup@example.com");
		const created = await createNewsletter(user, { name: "Early Notes" });
		const archive = await import("../app/archive/actions.js");
		const signup = await anonymous(() => archive.subscribe(null, form({ newsletter: created.slug, email: "early@example.org" })));
		assert.equal(signup.ok, true);
	});

	test("is the only page: issues, the list, the feed, the sitemap and llms.txt stay 404", async () => {
		const user = await customer("soon-404@example.com");
		const created = await createNewsletter(user, { name: "Hidden Notes" });
		assert.equal(await catchNotFound(m.issuesPage({ ...params(created.slug), searchParams: Promise.resolve({}) })), true);
		for (const [route, path] of [[m.feedRoute, "feed"], [m.sitemapRoute, "sitemap"], [m.llmsRoute, "llms"]]) {
			const response = await route.GET(new Request(`http://localhost:3000/archive/${created.slug}/${path}`), params(created.slug));
			assert.equal(response.status, 404, path);
		}
		assert.equal(await m.archiveData.getArchiveNewsletter(created.slug), null, "everything but the home page asks for a newsletter with an issue");
		assert.equal((await m.archiveData.getArchiveSite(created.slug)).comingSoon, true);
	});

	test("stays a 404 when the website is off or the account is waiting for its deletion", async () => {
		const user = await customer("soon-off@example.com");
		const off = await createNewsletter(user, { name: "Off Notes", archiveEnabled: false });
		assert.equal(await catchNotFound(m.homePage(params(off.slug))), true);
		assert.equal(await catchNotFound(m.layout({ ...params(off.slug), children: null })), true);
		assert.equal(await m.archiveData.getArchiveSite(off.slug), null);

		const deleting = await customer("soon-deleting@example.com");
		const created = await createNewsletter(deleting, { name: "Leaving Notes" });
		assert.equal(await catchNotFound(m.homePage(params(created.slug))), false, "on first");
		await m.Account.updateOne({ _id: deleting.accountId }, { $set: { deletion: { requestedAt: new Date(), purgeAt: new Date(Date.now() + 86_400_000) } } });
		assert.equal(await m.archiveData.getArchiveSite(created.slug), null);
	});

	test("is the real home page once the first issue is out: the list, the feed and the index are back", async () => {
		const user = await customer("soon-live@example.com");
		const created = await createNewsletter(user, { name: "Live Notes", postalAddress: "1 Main St, Paris" });
		await as(user, () => m.contacts.importContacts({ newsletterId: created.id, consent: true, rows: [{ email: "reader@example.org", status: "active" }] }));
		const id = (await as(user, () => catchRedirect(m.campaigns.createCampaign(created.id)))).split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "The first one", previewText: "Hello", body: "<p>Hello readers</p>" }));
		assert.match(text(await visit(created.slug)), /First issue coming soon/, "a draft isn't an issue");
		await as(user, () => m.campaigns.sendCampaign(id, {}));
		const markup = await visit(created.slug);
		assert.doesNotMatch(text(markup), /First issue coming soon/);
		assert.match(text(markup), /Latest issue/);
		assert.match(text(markup), /The first one/);
		assert.match(markup, /RSS feed/);
		assert.equal((await m.homeMetadata(params(created.slug))).robots.index, true);
		assert.ok(await m.archiveData.getArchiveNewsletter(created.slug));
		assert.equal((await m.archiveData.getArchiveNewsletter(created.slug)).comingSoon, undefined, "the flag is the home page's alone");
	});
});
