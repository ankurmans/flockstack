import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { getArchiveUrls, getArchiveHostUrl } from "../lib/archive-hosts.js";
import { buildFeed, escapeXml, getFeedGuid, isFreeIssue } from "../lib/archive-feed.js";
import { getHomeSeo, getIssueSeo } from "../lib/archive-seo.js";
import { activate, as, callApi, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

const SHARED_DOMAIN = "flockstackmail.com";
const APP = "https://flockstack.test";
let app;
let m;

const newsletter = {
	name: "Field notes & <more>",
	slug: "field-notes",
	fromName: "Jane Doe",
	description: 'One idea "every" Sunday',
	imageUrl: "/logos/field-notes.webp",
};

function issue(fields) {
	return {
		_id: "6650f1c2e9b1d4a012345678",
		subject: "How to price a side project",
		previewText: "Charge more than feels right.",
		archiveSlug: "how-to-price-a-side-project",
		format: "rich",
		html: "<p>Hello <strong>readers</strong></p>",
		sentAt: new Date("2026-10-04T08:30:00Z"),
		...fields,
	};
}

// A real parser's verdict when the machine has one; the string checks below hold either way.
function isWellFormed(xml) {
	const folder = mkdtempSync(join(tmpdir(), "feed-"));
	try {
		const file = join(folder, "feed.xml");
		writeFileSync(file, xml);
		const result = spawnSync("xmllint", ["--noout", file], { encoding: "utf8" });
		if (result.error) return null;
		assert.equal(result.status, 0, result.stderr);
		return true;
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

before(async () => {
	app = await startTestApp();
	m = {
		feedRoute: await import("../app/archive/[slug]/feed/route.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		Campaign: (await import("../models/Campaign.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("the feed builder", () => {
	test("is RSS 2.0 with the full issue in content:encoded, RFC 822 dates and a self link", () => {
		const { xml, lastModified } = buildFeed({ newsletter, issues: [issue()], urls: getArchiveUrls(newsletter, { sharedDomain: SHARED_DOMAIN, appUrl: APP }), appUrl: APP });
		assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0"/);
		assert.match(xml, /<atom:link href="https:\/\/field-notes\.flockstackmail\.com\/feed\.xml" rel="self" type="application\/rss\+xml"\/>/);
		assert.match(xml, /<link>https:\/\/field-notes\.flockstackmail\.com\/<\/link>/);
		assert.match(xml, /<pubDate>Sun, 04 Oct 2026 08:30:00 GMT<\/pubDate>/);
		assert.match(xml, /<lastBuildDate>Sun, 04 Oct 2026 08:30:00 GMT<\/lastBuildDate>/);
		assert.match(xml, /<link>https:\/\/field-notes\.flockstackmail\.com\/p\/how-to-price-a-side-project<\/link>/);
		assert.match(xml, /<content:encoded><!\[CDATA\[<p>Hello <strong>readers<\/strong><\/p>\]\]><\/content:encoded>/);
		assert.match(xml, /<description>Charge more than feels right\.<\/description>/);
		assert.match(xml, /<image><url>https:\/\/flockstack\.test\/logos\/field-notes\.webp<\/url>/);
		assert.equal(lastModified.toISOString(), "2026-10-04T08:30:00.000Z");
		isWellFormed(xml);
	});

	test("escapes titles and descriptions, splits CDATA endings and drops characters XML can't hold", () => {
		const tricky = issue({
			subject: 'Q&A: <b>"quotes"</b> & \u0007bells',
			previewText: "",
			html: "<p>Ends the section ]]&gt; early? ]]> really</p><p>\u0001ok</p>",
		});
		const { xml } = buildFeed({ newsletter, issues: [tricky], appUrl: APP });
		assert.match(xml, /<title>Q&amp;A: &lt;b&gt;&quot;quotes&quot;&lt;\/b&gt; &amp; bells<\/title>/);
		assert.match(xml, /<title>Field notes &amp; &lt;more&gt;<\/title>/);
		assert.match(xml, /<description>One idea &quot;every&quot; Sunday<\/description>/);
		assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
		assert.doesNotMatch(xml, /<!\[CDATA\[[^\]]*\]\]>[^<]/, "no CDATA section ends early");
		assert.equal(escapeXml("a & b < c"), "a &amp; b &lt; c");
		isWellFormed(xml);
	});

	test("gives each issue a guid that survives a move to the newsletter's own domain", () => {
		const issues = [issue()];
		const shared = buildFeed({ newsletter, issues, urls: getArchiveUrls(newsletter, { sharedDomain: SHARED_DOMAIN, appUrl: APP }), appUrl: APP }).xml;
		const own = buildFeed({ newsletter: { ...newsletter, archiveHost: "news.example.com" }, issues, appUrl: APP }).xml;
		const guid = `<guid isPermaLink="false">${getFeedGuid(issues[0])}</guid>`;
		assert.ok(shared.includes(guid) && own.includes(guid));
		assert.match(own, /<link>https:\/\/news\.example\.com\/p\/how-to-price-a-side-project<\/link>/);
	});

	test("shows the visibility filter's issues only, free ones by default", () => {
		const issues = [
			issue({ _id: "6650f1c2e9b1d4a000000001", subject: "Free one" }),
			issue({ _id: "6650f1c2e9b1d4a000000002", subject: "Members only", access: "paid" }),
			issue({ _id: "6650f1c2e9b1d4a000000003", subject: "Free two", access: "free" }),
		];
		const titles = (xml) => [...xml.matchAll(/<item>\s*<title>([^<]*)<\/title>/g)].map(([, title]) => title);
		assert.deepEqual(titles(buildFeed({ newsletter, issues, appUrl: APP }).xml), ["Free one", "Free two"]);
		assert.deepEqual(titles(buildFeed({ newsletter, issues, appUrl: APP, filter: (item) => item.access === "paid" }).xml), ["Members only"]);
		assert.equal(isFreeIssue({}), true);
		assert.equal(isFreeIssue({ access: "paid" }), false);
	});

	test("keeps a designed HTML issue's body and none of its head or scripts", () => {
		const html = "<!doctype html><html><head><title>Hidden title</title><style>p{color:red}</style></head><body><script>alert(1)</script><h1>Big news</h1><p>Read <a href=\"https://example.com/x\">this</a></p></body></html>";
		const { xml } = buildFeed({ newsletter, issues: [issue({ format: "html", html })], appUrl: APP });
		assert.match(xml, /<h1>Big news<\/h1>/);
		assert.doesNotMatch(xml, /Hidden title|alert\(1\)|color:red/);
	});

	test("stops at thirty issues and renders Markdown issues as HTML", () => {
		const issues = Array.from({ length: 40 }, (_, index) => issue({ _id: `6650f1c2e9b1d4a0${String(index).padStart(8, "0")}`, format: "markdown", markdown: "Some **bold** words" }));
		const { xml } = buildFeed({ newsletter, issues, appUrl: APP });
		assert.equal(xml.match(/<item>/g).length, 30);
		assert.match(xml, /<strong>bold<\/strong>/);
	});
});

describe("autodiscovery and links", () => {
	test("every archive page points readers' apps at the feed", async () => {
		const home = getHomeSeo({ ...newsletter, archiveHost: "news.example.com" }, APP).metadata.alternates;
		assert.deepEqual(home.types["application/rss+xml"], [{ url: "https://news.example.com/feed.xml", title: newsletter.name }]);
		const post = await withEnv({ SHARED_DOMAIN: "" }, () => getIssueSeo(newsletter, issue(), APP).metadata.alternates);
		assert.equal(post.types["application/rss+xml"][0].url, `${APP}/archive/field-notes/feed`, "without a host the feed stays under /archive");
	});

	test("the app domain's feed moves to /feed.xml on the shared subdomain", () => {
		assert.equal(getArchiveHostUrl("/archive/weekly/feed", "", SHARED_DOMAIN), "https://weekly.flockstackmail.com/feed.xml");
		assert.equal(getArchiveUrls({ slug: "weekly" }, { sharedDomain: SHARED_DOMAIN, appUrl: APP }).feed, "https://weekly.flockstackmail.com/feed.xml");
	});
});

describe("the feed route", () => {
	async function website(email, name) {
		const user = await signIn(email);
		await activate(user);
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		const created = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name, postalAddress: "1 Main St, Paris" } });
		assert.equal(created.status, 201);
		user.newsletter = created.body;
		return user;
	}

	function addIssue(user, fields) {
		return m.Campaign.create({
			accountId: user.accountId,
			newsletterId: user.newsletter.id,
			status: "sent",
			format: "rich",
			sentAt: new Date("2026-10-01T08:00:00Z"),
			startedAt: new Date("2026-10-01T08:00:00Z"),
			...fields,
		});
	}

	const get = (slug, headers = {}) =>
		m.feedRoute.GET(new Request(`https://${slug}.${SHARED_DOMAIN}/feed.xml`, { headers }), { params: Promise.resolve({ slug }) });

	test("serves the listed issues with caching headers, and answers a repeat request with 304", async () => {
		const user = await website("feed-owner@example.com", "Feed notes");
		await addIssue(user, { subject: "First", archiveSlug: "first", html: "<p>First body</p>", sentAt: new Date("2026-10-01T08:00:00Z") });
		await addIssue(user, { subject: "Second", archiveSlug: "second", html: "<p>Second body</p>", sentAt: new Date("2026-10-08T08:00:00Z"), startedAt: new Date("2026-10-08T08:00:00Z") });
		await addIssue(user, { subject: "Hidden", archiveSlug: "hidden", html: "<p>Not for the archive</p>", archiveListed: false });
		await addIssue(user, { subject: "Draft", archiveSlug: "draft", status: "draft", html: "<p>Draft</p>" });

		const response = await get("feed-notes");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
		assert.match(response.headers.get("cache-control"), /public, .*s-maxage=900/);
		assert.equal(response.headers.get("last-modified"), "Thu, 08 Oct 2026 08:00:00 GMT");
		const xml = await response.text();
		assert.deepEqual([...xml.matchAll(/<item>\s*<title>([^<]*)/g)].map(([, title]) => title), ["Second", "First"], "newest first, without the unlisted issue or the draft");
		assert.match(xml, /<content:encoded><!\[CDATA\[<p>Second body<\/p>\]\]>/);
		assert.doesNotMatch(xml, /Not for the archive|Draft/);
		assert.equal(isWellFormed(xml) ?? true, true);

		const etag = response.headers.get("etag");
		const again = await get("feed-notes", { "if-none-match": etag });
		assert.equal(again.status, 304);
		assert.equal(await again.text(), "");
		assert.equal((await get("feed-notes", { "if-none-match": '"other"' })).status, 200);
	});

	test("is not there for a website that is off or has no issue yet", async () => {
		const user = await website("feed-empty@example.com", "Empty notes");
		assert.equal((await get("empty-notes")).status, 404, "no issue yet");
		await addIssue(user, { subject: "Out", archiveSlug: "out" });
		assert.equal((await get("empty-notes")).status, 200);
		await m.Newsletter.updateOne({ accountId: user.accountId, slug: "empty-notes" }, { $set: { archiveEnabled: false } });
		assert.equal((await get("empty-notes")).status, 404, "archive switched off");
		assert.equal((await get("no-such-newsletter")).status, 404);
	});

	test("the newsletter's own host reaches it at /feed.xml through the proxy", async () => {
		const url = `https://weekly.${SHARED_DOMAIN}/feed.xml`;
		const rewritten = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
		assert.match(rewritten.headers.get("x-middleware-rewrite"), /\/archive\/weekly\/feed$/);
	});
});
