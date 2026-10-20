import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { catchNotFound } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// The link-in-bio page: what may be listed, the actions, the public page at /links and the proxy that serves it.
let t;
let m;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
	m = {
		rules: await import("../lib/link-page.js"),
		page: (await import("../app/archive/[slug]/links/page.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
	};
});

after(() => t?.app.stop());

// A newsletter with its website on, as the settings form saves it.
async function customer() {
	const user = await t.customer(`links${++n}@example.com`);
	await t.m.Newsletter.updateOne({ _id: user.newsletterId, accountId: user.accountId }, { $set: { archiveEnabled: true } });
	return user;
}
const update = (user, body) => t.api(user.key, "PATCH", "/link-page", body);

async function render(slug) {
	return renderToStaticMarkup(await m.page({ params: Promise.resolve({ slug }) }));
}

describe("a link's address", () => {
	test("is a web or email address, written bare or in full", () => {
		const { normalizeLinkUrl } = m.rules;
		assert.equal(normalizeLinkUrl("https://example.com/shop"), "https://example.com/shop");
		assert.equal(normalizeLinkUrl("example.com/shop"), "https://example.com/shop");
		assert.equal(normalizeLinkUrl("  http://example.com  "), "http://example.com/");
		assert.equal(normalizeLinkUrl("jane@example.com"), "mailto:jane@example.com");
		assert.equal(normalizeLinkUrl("mailto:jane@example.com"), "mailto:jane@example.com");
	});

	test("is never a script, a file, an address with a password or something that isn't one", () => {
		const { normalizeLinkUrl } = m.rules;
		for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<b>", "vbscript:x", "file:///etc/passwd", "ftp://example.com", "https://user:pass@example.com", "https://localhost", "not a link", "", null, `https://example.com/${"a".repeat(2000)}`]) {
			assert.equal(normalizeLinkUrl(bad), null, String(bad).slice(0, 40));
		}
	});

	test("lists up to 20 with a label and an address each, and names the first that isn't right", () => {
		const { readLinks } = m.rules;
		assert.deepEqual(readLinks([{ label: "  My   shop ", url: "example.com/shop" }]), { links: [{ label: "My shop", url: "https://example.com/shop" }] });
		assert.match(readLinks([{ label: "", url: "example.com" }]).error, /links\.0\.label/);
		assert.match(readLinks([{ label: "Ok", url: "example.com" }, { label: "Bad", url: "javascript:x" }]).error, /links\.1\.url/);
		assert.match(readLinks(Array.from({ length: 21 }, () => ({ label: "A", url: "example.com" }))).error, /20 at most/);
		assert.match(readLinks("nope").error, /send a list/);
	});
});

describe("get_link_page and update_link_page", () => {
	test("start off, with an address on the newsletter's website, and save what is listed in order", async () => {
		const user = await customer();
		const start = await t.api(user.key, "GET", "/link-page");
		assert.equal(start.status, 200, JSON.stringify(start.body));
		assert.deepEqual({ enabled: start.body.enabled, links: start.body.links, isLive: start.body.isLive }, { enabled: false, links: [], isLive: false });
		assert.match(start.body.url, new RegExp(`^https://${user.slug}\\.flockstackmail\\.com/links$`));

		const saved = await update(user, { enabled: true, title: "Notes", bio: "Weekly letters.", links: [{ label: "Shop", url: "example.com/shop" }, { label: "Podcast", url: "https://example.com/pod" }] });
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		assert.deepEqual(saved.body.links.map(({ label }) => label), ["Shop", "Podcast"]);
		assert.equal(saved.body.links[0].url, "https://example.com/shop");
		assert.equal(saved.body.isLive, true);

		const reordered = await update(user, { links: [{ label: "Podcast", url: "https://example.com/pod" }] });
		assert.deepEqual(reordered.body.links.map(({ label }) => label), ["Podcast"], "links replaces the list");
		assert.equal(reordered.body.title, "Notes", "what isn't sent stays");
		assert.equal((await update(user, { enabled: false })).body.links.length, 1, "off keeps the list");
	});

	test("refuse a link a page may not hold, too many and a newsletter that isn't the account's", async () => {
		const user = await customer();
		const other = await customer();
		t.assertError(await update(user, { links: [{ label: "Bad", url: "javascript:alert(1)" }] }), 400, "validation_failed");
		t.assertError(await update(user, { links: Array.from({ length: 21 }, (_, index) => ({ label: `L${index}`, url: "example.com" })) }), 400, "validation_failed");
		t.assertError(await update(user, { bio: "x".repeat(301) }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "GET", `/link-page?newsletter=${other.slug}`), 404, "not_found");
		assert.deepEqual((await t.api(user.key, "GET", "/link-page")).body.links, []);
	});
});

describe("the page at /links", () => {
	test("shows the signup first and then the links, opening the web ones in a new tab", async () => {
		const user = await customer();
		await t.api(user.key, "POST", "/campaigns", { subject: "First" });
		const issue = (await t.api(user.key, "GET", "/campaigns")).body.campaigns[0];
		await t.m.Campaign.updateOne({ _id: issue.id, accountId: user.accountId }, { $set: { status: "sent", sentAt: new Date(), archiveSlug: `first-${user.slug}` } });
		await update(user, { enabled: true, title: "Field Notes", bio: "One idea a week.", links: [{ label: "The shop", url: "example.com/shop" }, { label: "Write to me", url: "me@example.com" }] });

		const html = await render(user.slug);
		assert.match(html, /<h1[^>]*>Field Notes<\/h1>/);
		assert.match(html, /One idea a week\./);
		assert.ok(html.indexOf("Subscribe to") < html.indexOf("The shop"), "the signup is first");
		assert.match(html, /<a href="https:\/\/example\.com\/shop" target="_blank" rel="noopener noreferrer"[^>]*>The shop<\/a>/);
		assert.match(html, /<a href="mailto:me@example\.com"[^>]*>Write to me<\/a>/);
		assert.doesNotMatch(html, /mailto:me@example\.com"[^>]*target/, "an email address opens no tab");

		await t.m.Newsletter.updateOne({ _id: user.newsletterId, accountId: user.accountId }, { $push: { "linkPage.links": { label: "Stored bad", url: "javascript:alert(1)" } } });
		assert.doesNotMatch(await render(user.slug), /javascript:|Stored bad/, "whatever got stored, a script link isn't shown");

		await update(user, { title: "" });
		assert.match(await render(user.slug), /<h1[^>]*>.*news<\/h1>/, "the newsletter's name stands in for an empty title");
	});

	test("is a 404 while it is off, for a newsletter without a website yet and for one that isn't there", async () => {
		const user = await customer();
		assert.equal(await catchNotFound(render(user.slug)), true, "no issue yet");
		await t.api(user.key, "POST", "/campaigns", { subject: "First" });
		const issue = (await t.api(user.key, "GET", "/campaigns")).body.campaigns[0];
		await t.m.Campaign.updateOne({ _id: issue.id, accountId: user.accountId }, { $set: { status: "sent", sentAt: new Date(), archiveSlug: `first-${user.slug}` } });
		assert.equal(await catchNotFound(render(user.slug)), true, "the page is off");
		await update(user, { enabled: true });
		assert.match(await render(user.slug), /Subscribe to/);
		assert.equal(await catchNotFound(render("nobody-here")), true);
	});

	test("is served at /links on the newsletter's own host", async () => {
		const response = await m.proxy(new m.NextRequest("https://weekly.flockstackmail.com/links", { headers: { host: "weekly.flockstackmail.com" } }));
		assert.match(response.headers.get("x-middleware-rewrite"), /\/archive\/weekly\/links$/);
		const slash = await m.proxy(new m.NextRequest("https://weekly.flockstackmail.com/links/", { headers: { host: "weekly.flockstackmail.com" } }));
		assert.match(slash.headers.get("x-middleware-rewrite"), /\/archive\/weekly\/links\/?$/);
	});
});

describe("the dashboard", () => {
	test("saves the page through the same action", async () => {
		const user = await customer();
		const { as } = await import("./helpers/app.mjs");
		const actions = await import("../app/(app)/link-page/actions.js");
		const saved = await as(user, () => actions.saveLinkPage({ newsletterId: user.newsletterId, enabled: true, title: "T", bio: "B", links: [{ label: "A", url: "example.com" }] }));
		assert.equal(saved.ok, true);
		assert.deepEqual((await t.api(user.key, "GET", "/link-page")).body.links, [{ label: "A", url: "https://example.com/" }]);
		assert.match((await as(user, () => actions.saveLinkPage({ newsletterId: user.newsletterId, links: [{ label: "A", url: "javascript:1" }] }))).error, /links\.0\.url/);
	});
});
