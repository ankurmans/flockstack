import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, startTestApp, withEnv } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, loadSendingModules, setupSender } from "./helpers/sending.mjs";

// beehiiv parity X6 to X9: search title, description, social image and noindex for each issue, a newsletter's own
// JSON-LD, an llms.txt and a sitemap with the right lastmod on every newsletter's host.

const SHARED_DOMAIN = "flockstackmail.com";
let app;
let m;
let user;
let newsletter;

function params(more = {}) {
	return { params: Promise.resolve({ slug: newsletter.slug, ...more }) };
}

async function get(route, path) {
	const response = await route.GET(new Request(`http://localhost:3000/archive/${newsletter.slug}/${path}`), params());
	return { status: response.status, text: await response.text(), headers: response.headers };
}

// A website page inside what the archive's layout gives it.
async function render(element) {
	return renderToStaticMarkup(createElement(m.TooltipProvider, null, createElement(m.ProviderSubscribe, { newsletter: { slug: newsletter.slug, name: newsletter.name }, readers: 0 }, await element)));
}

function issue(overrides) {
	return m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, format: "rich", status: "sent", ...overrides });
}

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = {
		...(await loadSendingModules()),
		rules: await import("../lib/seo-rules.js"),
		seo: await import("../lib/archive-seo.js"),
		llms: await import("../lib/archive-llms.js"),
		hosts: await import("../lib/archive-hosts.js"),
		redirectPaths: await import("../lib/redirect-paths.js"),
		archivePage: (await import("../app/archive/[slug]/page.js")).default,
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		issueModule: await import("../app/archive/[slug]/p/[post]/page.js"),
		sitemapRoute: await import("../app/archive/[slug]/sitemap/route.js"),
		robotsRoute: await import("../app/archive/[slug]/robots/route.js"),
		llmsRoute: await import("../app/archive/[slug]/llms/route.js"),
		settingsPage: await import("../app/(app)/newsletters/page.js"),
		newsletterActions: await import("../app/(app)/newsletters/actions.js"),
		campaignActions: await import("../app/(app)/campaigns/actions.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		Product: (await import("../models/Product.js")).default,
	};
	user = await setupSender(m, "seo-owner@example.com", { contacts: 1 });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true, description: "Notes from the field." } });
	newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
});

after(() => app?.stop());

describe("structured data", () => {
	const faq = { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes." } }] };

	test("one block, a list of up to 5 or a graph is kept compact with a context, and anything else is refused with a reason", () => {
		const one = m.rules.checkJsonLd(JSON.stringify(faq, null, 2));
		assert.equal(one.text, JSON.stringify(faq));
		assert.deepEqual(one.blocks[0]["@context"], "https://schema.org");
		assert.equal(one.blocks[0]["@type"], "FAQPage");
		const list = m.rules.checkJsonLd(JSON.stringify([faq, { "@context": "https://schema.org", "@type": "Organization", name: "N" }]));
		assert.equal(list.blocks.length, 2);
		assert.equal(list.blocks[1]["@context"], "https://schema.org");
		assert.equal(m.rules.checkJsonLd(JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "N" }] })).blocks.length, 1);
		assert.deepEqual(m.rules.checkJsonLd("  "), { text: "", blocks: [] });

		const refused = [
			["{ not json", /isn't valid JSON/],
			["42", /"@type"/],
			['"text"', /"@type"/],
			["null", /"@type"/],
			["[]", /Add 1 to 5/],
			['["a"]', /"@type"/],
			['{ "name": "No type" }', /"@type"/],
			[JSON.stringify(Array.from({ length: 6 }, () => faq)), /Add 1 to 5/],
			[JSON.stringify({ "@type": "Thing", text: "x".repeat(20_000) }), /20,000 characters/],
			[`${"[".repeat(30)}${"]".repeat(30)}`, /"@type"|nested/],
			[JSON.stringify({ "@type": "Thing", a: JSON.parse(`${'{"b":'.repeat(20)}1${"}".repeat(20)}`) }), /nested too deeply/],
		];
		for (const [text, pattern] of refused) assert.match(m.rules.getJsonLdProblem(text), pattern, text.slice(0, 40));
		assert.equal(m.rules.getJsonLdProblem(JSON.stringify(faq)), null);
	});

	test("embedded in a script tag, nothing a string says can end it, open a comment or break a line", () => {
		const hostile = { "@type": "Thing", name: "</script><script>alert(1)</script><!-- <script>", note: "line\u2028break\u2029here" };
		const json = m.rules.toScriptJson(hostile);
		assert.doesNotMatch(json, /<|\u2028|\u2029/);
		assert.deepEqual(JSON.parse(json), hostile, "and it reads back as written");
		const html = renderToStaticMarkup(createElement("div", null, createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: json } })));
		assert.equal(html.match(/<script/g).length, 1);
		assert.equal(html.match(/<\/script/g).length, 1);
	});

	test("saved with update_newsletter, shown compact by get_newsletter, and refused when it isn't valid", async () => {
		const saved = await act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: JSON.stringify(faq, null, 2) });
		assert.equal(saved.jsonLd, JSON.stringify(faq));
		await assert.rejects(act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: "{ nope" }), { code: "validation_failed", message: /isn't valid JSON/ });
		await assert.rejects(act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: JSON.stringify({ name: "No type" }) }), { code: "validation_failed" });
		assert.equal((await act(m, user, "get_newsletter", { id: user.newsletterId })).jsonLd, JSON.stringify(faq));
		assert.equal((await act(m, user, "update_newsletter", { id: user.newsletterId, description: "Notes from the field." })).jsonLd, JSON.stringify(faq), "other changes leave it");
		newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	});

	test("the home page and every issue's page carry the blocks, escaped, next to their own", async () => {
		await act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: JSON.stringify([faq, { "@type": "Organization", name: "Acme </script><script>alert(1)</script>" }]) });
		newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		await issue({ subject: "With data", archiveSlug: "with-data", sentAt: new Date("2026-10-01T10:00:00Z"), html: "<p>Body</p>" });

		for (const html of [await render(m.archivePage(params())), await render(m.issuePage(params({ post: "with-data" })))]) {
			const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(([, json]) => JSON.parse(json));
			assert.equal(blocks.length, 3, "its own, then the two");
			assert.deepEqual(blocks.slice(1).map((block) => block["@type"]), ["FAQPage", "Organization"]);
			assert.equal(blocks[2].name, "Acme </script><script>alert(1)</script>");
			assert.doesNotMatch(html, /<script>alert\(1\)/);
			assert.ok(html.includes("\\u003c/script"));
		}
		await act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: "" });
		assert.equal((await render(m.archivePage(params()))).match(/application\/ld\+json/g).length, 1, "removed, only its own is left");
	});
});

describe("an issue's search settings", () => {
	let campaign;

	before(async () => {
		campaign = await issue({ subject: "How to price", previewText: "Charge more.", archiveSlug: "how-to-price", sentAt: new Date("2026-10-02T10:00:00Z"), thumbnailUrl: "https://images.example.com/first.png", html: "<p>Body</p>" });
	});

	test("an SEO title, description and image replace the subject, the preview text and the picture, and noindex asks to be left out", async () => {
		const plain = m.seo.getIssueSeo(newsletter, campaign.toObject());
		assert.deepEqual([plain.metadata.title.absolute, plain.metadata.description, plain.metadata.robots], ["How to price", "Charge more.", { index: true, follow: true }]);

		const set = await act(m, user, "update_campaign_archive", { id: String(campaign._id), seoTitle: "Pricing a side project | Notes", seoDescription: "A short guide to charging more.", socialImage: "https://images.example.com/card.png", noindex: true });
		assert.deepEqual(set.seo, { title: "Pricing a side project | Notes", description: "A short guide to charging more.", image: "https://images.example.com/card.png", noindex: true });

		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: campaign._id }).lean();
		const { metadata, jsonLd } = m.seo.getIssueSeo(newsletter, stored);
		assert.equal(metadata.title.absolute, "Pricing a side project | Notes");
		assert.equal(metadata.description, "A short guide to charging more.");
		assert.deepEqual(metadata.robots, { index: false, follow: true });
		assert.equal(metadata.openGraph.title, "Pricing a side project | Notes");
		assert.equal(metadata.openGraph.images[0].url, "https://images.example.com/card.png");
		assert.equal(metadata.twitter.title, "Pricing a side project | Notes");
		assert.equal(jsonLd.headline, "How to price", "the article keeps its subject");
		assert.equal(jsonLd.description, "A short guide to charging more.");
		assert.deepEqual(jsonLd.image, ["https://images.example.com/card.png"]);

		const generated = await m.issueModule.generateMetadata(params({ post: "how-to-price" }));
		assert.deepEqual(generated.robots, { index: false, follow: true });
		assert.equal(generated.title.absolute, "Pricing a side project | Notes");
	});

	test("a field passed empty is cleared, one not passed stays, an unchanged one doesn't move the date, and a bad one is refused", async () => {
		const first = await m.Campaign.findOne({ accountId: user.accountId, _id: campaign._id }).lean();
		await act(m, user, "update_campaign_archive", { id: String(campaign._id), seoTitle: "Pricing a side project | Notes" });
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: campaign._id }).lean()).seo.updatedAt.getTime(), first.seo.updatedAt.getTime(), "nothing changed");

		const cleared = await act(m, user, "update_campaign_archive", { id: String(campaign._id), seoTitle: "", socialImage: "", noindex: false });
		assert.deepEqual(cleared.seo, { title: "", description: "A short guide to charging more.", image: "", noindex: false });
		await assert.rejects(act(m, user, "update_campaign_archive", { id: String(campaign._id), seoTitle: "x".repeat(121) }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "update_campaign_archive", { id: String(campaign._id), socialImage: "http://images.example.com/card.png" }), { code: "validation_failed", message: /https/ });
		await assert.rejects(act(m, user, "update_campaign_archive", { id: String(campaign._id), socialImage: "javascript:alert(1)" }), { code: "validation_failed" });
		await act(m, user, "update_campaign_archive", { id: String(campaign._id), seoDescription: "", noindex: false });
	});

	test("a draft can be set up before it goes out, from the dashboard too", async () => {
		const draft = await act(m, user, "create_campaign", { subject: "Draft", content: "<p>x</p>", format: "rich" });
		assert.equal((await act(m, user, "update_campaign_archive", { id: draft.id, seoTitle: "Early title" })).seo.title, "Early title");
		assert.equal((await as(user, () => m.campaignActions.setCampaignSeo(draft.id, { title: "From the form", description: "", image: "", noindex: true }))).ok, true);
		const { seo } = await act(m, user, "get_campaign", { id: draft.id });
		assert.deepEqual([seo.title, seo.noindex], ["From the form", true]);
	});
});

describe("the sitemap", () => {
	test("dates each page by when it last changed, and leaves out issues marked noindex", async () => {
		await m.Campaign.deleteMany({ accountId: user.accountId, newsletterId: user.newsletterId }).setOptions({ crossAccount: true });
		await issue({ subject: "Old", archiveSlug: "old", sentAt: new Date("2026-01-10T10:00:00Z") });
		await issue({ subject: "Tweaked", archiveSlug: "tweaked", sentAt: new Date("2026-02-10T10:00:00Z"), seo: { title: "New title", updatedAt: new Date("2026-06-01T08:00:00Z") } });
		await issue({ subject: "Hidden", archiveSlug: "hidden", sentAt: new Date("2026-09-10T10:00:00Z"), seo: { noindex: true, updatedAt: new Date("2026-09-11T08:00:00Z") } });
		await issue({ subject: "Unlisted", archiveSlug: "unlisted", archiveListed: false, sentAt: new Date("2026-09-20T10:00:00Z") });
		await issue({ subject: "Newest", archiveSlug: "newest", sentAt: new Date("2026-03-10T10:00:00Z"), seo: { title: "Older change", updatedAt: new Date("2026-01-01T00:00:00Z") } });

		const { status, text } = await get(m.sitemapRoute, "sitemap");
		assert.equal(status, 200);
		const lastmods = new Map([...text.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/g)].map(([, loc, lastmod]) => [loc.replace(/^https:\/\/[^/]+/, ""), lastmod]));
		assert.equal(lastmods.get("/p/old"), "2026-01-10T10:00:00.000Z");
		assert.equal(lastmods.get("/p/tweaked"), "2026-06-01T08:00:00.000Z", "a later change to its search settings");
		assert.equal(lastmods.get("/p/newest"), "2026-03-10T10:00:00.000Z", "an earlier change doesn't make it older");
		assert.equal(lastmods.has("/p/hidden"), false, "noindex");
		assert.equal(lastmods.has("/p/unlisted"), false, "unlisted");
		assert.equal(lastmods.get("/"), "2026-06-01T08:00:00.000Z", "the home page changes with its newest page");
		assert.equal(lastmods.get([...lastmods.keys()].find((key) => key.startsWith("/authors/"))), "2026-06-01T08:00:00.000Z");
	});

	test("dates the shop and its products by when they changed", async () => {
		const Account = (await import("../models/Account.js")).default;
		await Account.updateOne({ _id: user.accountId }, { $set: { "payments.stripeAccountId": "acct_seo", "payments.chargesEnabled": true } });
		const product = await m.Product.create({ accountId: user.accountId, newsletterId: user.newsletterId, title: "Guide", slug: "guide", priceCents: 900, currency: "usd", status: "active" });
		const changed = (await m.Product.findOne({ accountId: user.accountId, _id: product._id }).lean()).updatedAt.toISOString();
		const { text } = await get(m.sitemapRoute, "sitemap");
		assert.ok(text.includes(`/shop/guide</loc><lastmod>${changed}</lastmod>`), text);
		assert.ok(text.includes(`/shop</loc><lastmod>${changed}</lastmod>`), "the shop changes with its newest product");
	});

	test("robots.txt points at it, on the newsletter's own host and, without a shared domain, on the app", async () => {
		const hosted = await get(m.robotsRoute, "robots");
		assert.match(hosted.text, /^User-agent: \*\nAllow: \/\n\nSitemap: https:\/\/seo-owner\.flockstackmail\.com\/sitemap\.xml\n$/);
		await withEnv({ SHARED_DOMAIN: "" }, async () => {
			assert.match((await get(m.robotsRoute, "robots")).text, /Sitemap: http:\/\/localhost:3000\/archive\/seo-owner\/sitemap\n$/);
		});
	});
});

describe("llms.txt", () => {
	test("is the newsletter and its latest free issues, with its search titles, and leaves out paid, noindex and unlisted ones", async () => {
		await m.Campaign.deleteMany({ accountId: user.accountId, newsletterId: user.newsletterId }).setOptions({ crossAccount: true });
		await issue({ subject: "First [one]", previewText: "The\nfirst\n\none.", archiveSlug: "first", sentAt: new Date("2026-01-10T10:00:00Z") });
		await issue({ subject: "Second", previewText: "Plain", archiveSlug: "second", sentAt: new Date("2026-02-10T10:00:00Z"), seo: { title: "Second, found", description: "Found by search", updatedAt: new Date() } });
		await issue({ subject: "Paid", archiveSlug: "paid", audience: "paid", sentAt: new Date("2026-03-10T10:00:00Z") });
		await issue({ subject: "Hidden", archiveSlug: "hidden", sentAt: new Date("2026-04-10T10:00:00Z"), seo: { noindex: true } });
		await issue({ subject: "Unlisted", archiveSlug: "unlisted", archiveListed: false, sentAt: new Date("2026-05-10T10:00:00Z") });

		const { status, text, headers } = await get(m.llmsRoute, "llms");
		assert.equal(status, 200);
		assert.match(headers.get("content-type"), /^text\/plain/);
		assert.equal(
			text,
			[
				"# seo-owner",
				"> Notes from the field.",
				"Written by seo-owner.",
				"## Issues",
				"- [Second, found](https://seo-owner.flockstackmail.com/p/second): Found by search\n- [First (one)](https://seo-owner.flockstackmail.com/p/first): The first one.",
				"## More",
				"- [All issues](https://seo-owner.flockstackmail.com/)\n- [RSS feed with the full text of each issue](https://seo-owner.flockstackmail.com/feed.xml)\n- [Sitemap](https://seo-owner.flockstackmail.com/sitemap.xml)",
			].join("\n\n") + "\n"
		);
		const missing = await m.llmsRoute.GET(new Request("http://localhost:3000/archive/nobody/llms"), { params: Promise.resolve({ slug: "nobody" }) });
		assert.equal(missing.status, 404);
	});

	test("an empty website says so, and a long list stops at 50", () => {
		const urls = m.hosts.getArchiveUrls({ slug: "empty" }, { sharedDomain: null, appUrl: "https://app.test" });
		assert.match(m.llms.getLlmsTxt({ newsletter: { name: "Empty" }, issues: [], urls }), /## Issues\n\nNo issues yet\.\n\n## More/);
		const issues = Array.from({ length: 80 }, (_, index) => ({ subject: `Issue ${index}`, archiveSlug: `issue-${index}` }));
		assert.equal(m.llms.getLlmsTxt({ newsletter: { name: "Long" }, issues, urls }).match(/^- \[Issue/gm).length, 50);
	});

	test("is served at /llms.txt on the newsletter's host, and that path can't be redirected", async () => {
		for (const [path, target] of [["/llms.txt", "llms"], ["/sitemap.xml", "sitemap"], ["/robots.txt", "robots"]]) {
			const url = `https://${newsletter.slug}.${SHARED_DOMAIN}${path}`;
			const response = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
			assert.equal(new URL(response.headers.get("x-middleware-rewrite")).pathname, `/archive/${newsletter.slug}/${target}`, path);
		}
		assert.equal(m.hosts.getArchiveHostUrl("/archive/weekly/llms", "", SHARED_DOMAIN), "https://weekly.flockstackmail.com/llms.txt");
		assert.equal(m.redirectPaths.isReservedRedirectPath("/llms.txt"), true);
	});
});

describe("the settings page", () => {
	test("lists the files the website serves, a link to the redirects and the structured data box", async () => {
		await act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: JSON.stringify({ "@type": "Organization", name: "Acme" }) });
		const html = await as(user, async () => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.settingsPage.default())));
		assert.match(html, /Search engines and AI assistants/);
		for (const file of ["sitemap.xml", "robots.txt", "llms.txt", "feed.xml"]) assert.ok(html.includes(`https://seo-owner.${SHARED_DOMAIN}/${file}`), file);
		assert.match(html, /href="#redirects"/);
		assert.match(html, /id="redirects"/);
		assert.match(html, /&quot;name&quot;: &quot;Acme&quot;/);
		assert.deepEqual(Object.keys((await act(m, user, "get_newsletter", { id: user.newsletterId })).seoUrls), ["sitemap", "robots", "llms", "feed"]);

		assert.deepEqual(await as(user, () => m.newsletterActions.saveJsonLd(user.newsletterId, "{ nope")), { error: (await act(m, user, "update_newsletter", { id: user.newsletterId, jsonLd: "{ nope" }).catch((error) => error)).message });
		assert.equal((await as(user, () => m.newsletterActions.saveJsonLd(user.newsletterId, ""))).jsonLd, "");
	});
});
