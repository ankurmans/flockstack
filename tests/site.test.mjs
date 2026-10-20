import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { callApi, catchNotFound, startTestApp } from "./helpers/app.mjs";
import { SHARED_DOMAIN, addIssue, createPublisher, importModels } from "./helpers/community.mjs";

// A newsletter's website beyond its issues: custom pages at /p/<slug>, the navigation bar, issue tags and their pages, the
// paged list of issues with a search by title, the theme and accent on the page, and the sitemap that lists it all.
let app;
let m;
let counter = 0;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		layout: (await import("../app/archive/[slug]/layout.js")).default,
		home: (await import("../app/archive/[slug]/page.js")).default,
		post: (await import("../app/archive/[slug]/p/[post]/page.js")),
		issues: (await import("../app/archive/[slug]/issues/page.js")),
		tag: (await import("../app/archive/[slug]/tags/[tag]/page.js")),
		sitemap: await import("../app/archive/[slug]/sitemap/route.js"),
		robots: await import("../app/archive/[slug]/robots/route.js"),
		proxy: (await import("../proxy.js")).proxy,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		purge: await import("../lib/account-purge.js"),
		slugs: await import("../lib/archive-slugs.js"),
		SitePage: (await import("../models/SitePage.js")).default,
	};
});

after(() => app?.stop());

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });
const params = (user, more = {}) => ({ params: Promise.resolve({ slug: user.slug, ...more }) });
// The page inside the signup provider the layout puts around it.
const html = (element, user) => renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "n", slug: user?.slug ?? "n", signupFields: [] }, readers: 0 }, element));

async function publisher(options) {
	return createPublisher(m, `site${++counter}@example.com`, { comments: { enabled: false }, ...options });
}

async function newPage(user, fields = {}) {
	const response = await api(user, "POST", "/pages", { title: "About", content: "I write about small software companies.", status: "published", ...fields });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

async function renderPost(user, post) {
	return html(await m.post.default({ params: Promise.resolve({ slug: user.slug, post }) }), user);
}

// The layout around a marker child: the header, the navigation and the footer, as a visitor's page has them.
async function renderChrome(user) {
	return renderToStaticMarkup(await m.layout({ children: createElement("div", { id: "marker" }), params: Promise.resolve({ slug: user.slug }) }));
}

function visitHost(user, path) {
	const url = `https://${user.slug}.${SHARED_DOMAIN}${path}`;
	return m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
}

describe("custom pages", () => {
	test("start as drafts nobody can read, then publish at /p/<slug> with the editor's content", async () => {
		const user = await publisher();
		const draft = await newPage(user, { status: undefined, content: "# Hello\n\nI write about *small* software companies." });
		assert.deepEqual([draft.status, draft.slug, draft.url, draft.publishedAt], ["draft", "about", null, null]);
		assert.equal(await catchNotFound(renderPost(user, "about")), true, "a draft has no page");
		assert.doesNotMatch(await (await m.sitemap.GET(new Request("http://x"), params(user))).text(), /\/p\/about/);

		const published = await api(user, "PATCH", `/pages/${draft.id}`, { status: "published" });
		assert.equal(published.status, 200, JSON.stringify(published.body));
		assert.equal(published.body.url, `https://${user.slug}.${SHARED_DOMAIN}/p/about`);
		assert.ok(published.body.publishedAt);

		const page = await renderPost(user, "about");
		assert.match(page, /<h1[^>]*>About<\/h1>/);
		assert.match(page, /<h1>Hello<\/h1>/);
		assert.match(page, /<em>small<\/em> software companies/);
		assert.match(page, /id="subscribe"/, "ends with the signup form");
		assert.match(page, /"@type":"WebPage"/);

		await api(user, "PATCH", `/pages/${draft.id}`, { status: "draft" });
		assert.equal(await catchNotFound(renderPost(user, "about")), true, "unpublishing takes it offline");
	});

	test("are cleaned like an issue, whichever way they were written", async () => {
		const user = await publisher();
		const hostile = [
			"<p>Safe words</p>",
			"<script>alert(1)</script>",
			'<img src="https://example.com/a.png" onerror="alert(2)">',
			'<a href="javascript:alert(3)" onclick="alert(4)">bad link</a>',
			'<iframe src="https://evil.example.com"></iframe>',
			'<p style="position:fixed">styled</p>',
			'<form action="https://evil.example.com"><button>go</button></form>',
		].join("");
		const rich = await newPage(user, { title: "Rich", format: "rich", content: hostile });
		const markdown = await newPage(user, { title: "Marked", format: "markdown", content: `Safe words\n\n${hostile}\n\n[md bad](javascript:alert(5))` });
		for (const { slug, id } of [rich, markdown]) {
			const stored = (await api(user, "GET", `/pages/${id}`)).body.content;
			const shown = (await renderPost(user, slug)).match(/<div style="--stagger:1" class="prose-issue[^>]*>([\s\S]*?)<\/div><\/article>/)[1];
			for (const output of [stored, shown]) {
				assert.match(output, /Safe words/);
				assert.doesNotMatch(output.replace(/<script[^>]*src=[^>]*><\/script>/g, ""), /alert\(\d\)|<script>|onerror|onclick|javascript:|<iframe|evil\.example|position:fixed|<form/i, slug);
			}
		}
		assert.match((await api(user, "GET", `/pages/${rich.id}`)).body.content, /<img src="https:\/\/example\.com\/a\.png"/, "a picture stays");
	});

	test("keep the editor's blocks: a button in the accent, and a paywall break is ignored", async () => {
		const user = await publisher();
		await api(user, "PATCH", `/newsletters/${user.slug}`, { accentColor: "#1d4ed8" });
		await newPage(user, { title: "Sponsor", format: "rich", content: '<p>Before</p><div data-button=""><a href="https://example.com/sponsor">Sponsor us</a></div><div data-paywall=""></div><p>After the break</p>' });
		const page = await renderPost(user, "sponsor");
		assert.match(page, /<a href="https:\/\/example\.com\/sponsor" style="background:#1d4ed8;color:#ffffff;">Sponsor us<\/a>/);
		assert.match(page, /Before/);
		assert.match(page, /After the break/, "a page is for everyone");
		assert.doesNotMatch(page, /data-paywall|This issue is for paid/);
	});

	test("take a slug from the title, refuse one an issue or another page uses, and keep it apart from future issues", async () => {
		const user = await publisher({ issue: { archiveSlug: "taken-by-an-issue" } });
		const first = await newPage(user, { title: "Contact us" });
		assert.equal(first.slug, "contact-us");
		for (const slug of ["taken-by-an-issue", "contact-us"]) {
			const clash = await api(user, "POST", "/pages", { title: "Other", slug, content: "x" });
			assert.equal(clash.status, 409, slug);
			assert.match(clash.body.error.message, /already uses this slug/);
		}
		const bad = await api(user, "POST", "/pages", { title: "日本語" });
		assert.equal(bad.status, 400, "a title with no letters needs a slug of its own");
		assert.equal((await api(user, "POST", "/pages", { title: "日本語", slug: "nihongo", content: "x" })).status, 201);
		const renamed = await api(user, "PATCH", `/pages/${first.id}`, { slug: "taken-by-an-issue" });
		assert.equal(renamed.status, 409);

		// An issue that goes out later can't take a page's address, in the dashboard, the API or the send.
		const issue = await addIssue(m, user, { subject: "Contact us", archiveSlug: undefined, status: "draft" });
		const taken = await api(user, "PATCH", `/campaigns/${issue._id}/archive`, { slug: "contact-us" });
		assert.equal(taken.status, 409, JSON.stringify(taken.body));
		assert.equal(await m.slugs.uniqueArchiveSlug("contact-us", { newsletterId: user.newsletterId }), "contact-us-2");
		assert.equal(await m.slugs.uniqueArchiveSlug("contact-us"), "contact-us", "another newsletter's page doesn't count");
		await m.slugs.assignArchiveSlug({ campaign: { ...issue, archiveSlug: undefined }, newsletter: user.newsletter });
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: issue._id }).lean()).archiveSlug, "contact-us-2");
	});

	test("belong to one newsletter: another's visitors, hosts and sitemaps never see them", async () => {
		const owner = await publisher();
		const other = await publisher();
		await newPage(owner, { title: "Private About", slug: "about" });
		assert.equal(await catchNotFound(renderPost(other, "about")), true);
		assert.match(await renderPost(owner, "about"), /Private About/);
		assert.doesNotMatch(await (await m.sitemap.GET(new Request("http://x"), params(other))).text(), /\/p\/about/);
	});

	test("are routed from the newsletter's host to /p/<slug>, next to the issues", async () => {
		const user = await publisher();
		await newPage(user);
		for (const path of ["/p/about", `/p/${user.issue.archiveSlug}`]) {
			const response = await visitHost(user, path);
			assert.equal(response.headers.get("x-middleware-rewrite"), `https://${user.slug}.${SHARED_DOMAIN}/archive/${user.slug}/p/${path.split("/").pop()}`, path);
		}
		for (const [path, target] of [["/issues", "issues"], ["/issues/", "issues"], ["/tags/interviews", "tags/interviews"], ["/signin", "signin"], ["/account", "account"]]) {
			const response = await visitHost(user, path);
			assert.equal(response.headers.get("x-middleware-rewrite")?.replace(/\/$/, ""), `https://${user.slug}.${SHARED_DOMAIN}/archive/${user.slug}/${target}`, path);
		}
		assert.equal((await visitHost(user, "/tags/Bad_Tag")).status, 404, "a tag path that isn't a slug is not found");
		assert.equal((await visitHost(user, "/p/UPPER")).status, 404);
	});

	test("are listed with the newsletter's, limited, and go with a deleted page and a deleted account", async () => {
		const user = await publisher();
		const keep = await newPage(user, { title: "Keep" });
		const gone = await newPage(user, { title: "Gone" });
		const listed = await api(user, "GET", "/pages");
		assert.deepEqual(listed.body.pages.map((page) => page.slug), ["keep", "gone"]);
		assert.equal("content" in listed.body.pages[0], false, "the list leaves content out");
		const deleted = await api(user, "DELETE", `/pages/${gone.id}`);
		assert.deepEqual(deleted.body, { id: gone.id, deleted: true });
		assert.equal((await api(user, "GET", `/pages/${gone.id}`)).status, 404);
		assert.equal(await catchNotFound(renderPost(user, "gone")), true);

		for (let index = 0; index < 24; index += 1) await newPage(user, { title: `Filler ${index}`, content: "x" });
		const full = await api(user, "POST", "/pages", { title: "One too many", content: "x" });
		assert.equal(full.status, 409, JSON.stringify(full.body));
		assert.match(full.body.error.message, /up to 25 pages/);
		assert.ok(m.purge.CONTENT_MODELS.includes(m.SitePage), "a deleted account's pages are purged");
		assert.ok(keep.id);
	});

	test("refuse a body over 200 KB and an empty title", async () => {
		const user = await publisher();
		const big = await api(user, "POST", "/pages", { title: "Big", format: "rich", content: `<p>${"x".repeat(250_000)}</p>` });
		assert.equal(big.status, 400, JSON.stringify(big.body).slice(0, 200));
		assert.equal((await api(user, "POST", "/pages", { title: " ", content: "x" })).status, 400);
	});
});

describe("the navigation", () => {
	test("is saved in the order sent, with pages by slug or ID, and shown in that order", async () => {
		const user = await publisher();
		const about = await newPage(user, { title: "About me" });
		const sponsor = await newPage(user, { title: "Sponsor", slug: "sponsor-us" });
		const saved = await api(user, "PATCH", "/navigation", {
			items: [
				{ kind: "page", page: "sponsor-us", label: "Advertise" },
				{ kind: "archive" },
				{ kind: "page", page: about.id },
				{ kind: "tag", tag: "Interviews" },
				{ kind: "link", label: "Podcast", url: "https://example.com/podcast" },
			],
		});
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		assert.deepEqual(
			saved.body.items.map(({ kind, text, href }) => [kind, text, href]),
			[
				["page", "Advertise", `https://${user.slug}.${SHARED_DOMAIN}/p/sponsor-us`],
				["archive", "Archive", `https://${user.slug}.${SHARED_DOMAIN}/issues`],
				["page", "About me", `https://${user.slug}.${SHARED_DOMAIN}/p/about-me`],
				["tag", "interviews", `https://${user.slug}.${SHARED_DOMAIN}/tags/interviews`],
				["link", "Podcast", "https://example.com/podcast"],
			]
		);
		assert.deepEqual((await api(user, "GET", "/navigation")).body, saved.body);

		const chrome = await renderChrome(user);
		const links = [...chrome.matchAll(/<nav aria-label="Pages"[^>]*>([\s\S]*?)<\/nav>/g)].map(([, nav]) => [...nav.matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)].map(([, href, rest, label]) => [label, href, rest]));
		assert.equal(links.length, 2, "in the header and the footer");
		for (const list of links) {
			assert.deepEqual(list.map(([label]) => label), ["Advertise", "Archive", "About me", "interviews", "Podcast"]);
			assert.match(list.at(-1)[2], /rel="noopener noreferrer"/, "an outside link opens safely");
			assert.doesNotMatch(list[0][2], /rel=/);
		}
		assert.ok(sponsor.id);
	});

	test("keep each link's identity when reordered, and leave a draft page out of the bar until it is published", async () => {
		const user = await publisher();
		const draft = await newPage(user, { title: "Soon", status: "draft" });
		const live = await newPage(user, { title: "Live" });
		const first = await api(user, "PATCH", "/navigation", { items: [{ kind: "page", page: draft.id }, { kind: "page", page: live.id }] });
		const [soon, now] = first.body.items;
		assert.equal(soon.href, null, "a draft has nowhere to go");
		assert.doesNotMatch(await renderChrome(user), />Soon</);
		assert.match(await renderChrome(user), />Live</);

		const reordered = await api(user, "PATCH", "/navigation", { items: [{ id: now.id, kind: "page", page: live.id }, { id: soon.id, kind: "page", page: draft.id }] });
		assert.deepEqual(reordered.body.items.map(({ id }) => id), [now.id, soon.id]);
		await api(user, "PATCH", `/pages/${draft.id}`, { status: "published" });
		assert.match(await renderChrome(user), />Soon</);
	});

	test("refuse links that aren't https, a page that doesn't exist, a link without a label and more than twelve", async () => {
		const user = await publisher();
		const bad = async (items) => (await api(user, "PATCH", "/navigation", { items })).status;
		assert.equal(await bad([{ kind: "link", label: "Plain", url: "http://example.com" }]), 400);
		assert.equal(await bad([{ kind: "link", label: "Script", url: "javascript:alert(1)" }]), 400);
		assert.equal(await bad([{ kind: "link", url: "https://example.com" }]), 400, "a link needs a label");
		assert.equal(await bad([{ kind: "page", page: "no-such-page" }]), 400);
		assert.equal(await bad([{ kind: "page" }]), 400);
		assert.equal(await bad(Array.from({ length: 13 }, () => ({ kind: "archive" }))), 400);
		assert.equal(await bad(Array.from({ length: 12 }, () => ({ kind: "archive" }))), 200);
		assert.deepEqual((await api(user, "PATCH", "/navigation", { items: [] })).body, { items: [] });
	});

	test("drop a page when it is deleted, and escape what a label holds", async () => {
		const user = await publisher();
		const page = await newPage(user, { title: "Soon gone" });
		await api(user, "PATCH", "/navigation", { items: [{ kind: "page", page: page.id }, { kind: "link", label: "<b>Bold</b> & co", url: "https://example.com/a?b=1&c=2" }] });
		await api(user, "DELETE", `/pages/${page.id}`);
		const { items } = (await api(user, "GET", "/navigation")).body;
		assert.deepEqual(items.map(({ kind }) => kind), ["link"]);
		const chrome = await renderChrome(user);
		assert.match(chrome, /&lt;b&gt;Bold&lt;\/b&gt; &amp; co/);
		assert.match(chrome, /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
	});
});

async function manyIssues2(user) {
	await addIssue(m, user, { subject: "Second issue", sentAt: new Date(Date.now() - 86_400_000) });
	await addIssue(m, user, { subject: "Third issue", sentAt: new Date(Date.now() - 2 * 86_400_000) });
}

describe("the theme on the website", () => {
	test("sets the theme, the accent and the fonts for the page and nothing a visitor typed", async () => {
		const user = await publisher();
		const plain = await renderChrome(user);
		assert.match(plain, /data-site-theme="classic"/);
		assert.match(plain, /class="theme-neutral /, "still the neutral design");
		assert.doesNotMatch(plain, /--primary:/, "a newsletter with no accent keeps the neutral colors");
		assert.doesNotMatch(plain, /--site-font-body/, "and its own typeface");

		await api(user, "PATCH", `/newsletters/${user.slug}`, { accentColor: "#e11d48", brand: { theme: "magazine", fontPair: "editorial" } });
		const chrome = await renderChrome(user);
		assert.match(chrome, /data-site-theme="magazine"/);
		const css = chrome.match(/<style>([\s\S]*?)<\/style>/)[1];
		assert.match(css, /:root:has\(\[data-site-theme="magazine"\]\),\[data-site-theme="magazine"\]\{/);
		assert.match(css, /--background:#faf6ee/);
		assert.match(css, /\.dark:has\(\[data-site-theme="magazine"\]\),\.dark \[data-site-theme="magazine"\]\{/);
		assert.match(css, /--primary:#e11d48;--primary-foreground:#ffffff/);
		assert.match(css, /--site-font-heading:Georgia,/);
		assert.doesNotMatch(css, /classic|minimal|bold/, "only the chosen theme");
		assert.equal(/[<>"]/.test(css.replaceAll('"magazine"', "")), false, "nothing that could end the style");
	});

	test("shows the header image above the home page's hero, and a minimal theme as a list", async () => {
		const user = await publisher();
		await api(user, "PATCH", `/newsletters/${user.slug}`, { brand: { theme: "minimal", headerUrl: "https://cdn.example.com/h.jpg" } });
		await manyIssues2(user);
		const page = html(await m.home(params(user)), user);
		assert.match(page, /cdn\.example\.com%2Fh\.jpg|cdn\.example\.com\/h\.jpg/);
		assert.match(page, /class="site-hero /);
		assert.match(page, /<ol class="divide-y/, "a list of titles, not cards");
		await api(user, "PATCH", `/newsletters/${user.slug}`, { brand: { theme: "bold" } });
		assert.doesNotMatch(html(await m.home(params(user)), user), /<ol class="divide-y/);
	});

	test("the link to sign in is on every page of the site", async () => {
		const user = await publisher();
		const chrome = await renderChrome(user);
		assert.match(chrome, new RegExp(`href="https://${user.slug}\\.${SHARED_DOMAIN}/signin"[^>]*>Sign in</a>`));
	});
});

describe("issue tags", () => {
	async function tagged(user, subject, tags, extra = {}) {
		const issue = await addIssue(m, user, { subject, ...extra });
		const response = await api(user, "PATCH", `/campaigns/${issue._id}/archive`, { tags });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		return { issue, body: response.body };
	}

	test("are set on any issue, normalized, each once, and returned", async () => {
		const user = await publisher();
		const { body } = await tagged(user, "Tagged", ["Interviews", " interviews ", "Tools & Tips", "q3  plan"]);
		assert.deepEqual(body.tags, ["interviews", "tools & tips", "q3 plan"]);
		const detail = await api(user, "GET", `/campaigns/${body.id}`);
		assert.deepEqual(detail.body.tags, ["interviews", "tools & tips", "q3 plan"]);
		assert.deepEqual((await api(user, "PATCH", `/campaigns/${body.id}/archive`, { tags: [] })).body.tags, []);
		const drafted = await api(user, "POST", "/campaigns", { subject: "Draft", content: "Hi", tags: ["Draft tag"] });
		assert.deepEqual(drafted.body.tags, ["draft tag"]);
		assert.deepEqual((await api(user, "PATCH", `/campaigns/${drafted.body.id}`, { tags: ["other"] })).body.tags, ["other"]);
	});

	test("refuse what isn't a tag and more than ten", async () => {
		const user = await publisher();
		const issue = await addIssue(m, user, {});
		const set = (tags) => api(user, "PATCH", `/campaigns/${issue._id}/archive`, { tags });
		for (const bad of ["<script>", "日本語", "!!!", "x".repeat(61)]) assert.equal((await set([bad])).status, 400, bad);
		assert.equal((await set(Array.from({ length: 11 }, (_, index) => `tag ${index}`))).status, 400);
		assert.equal((await set(Array.from({ length: 10 }, (_, index) => `tag ${index}`))).status, 200);
	});

	test("show as chips on the issue and list their issues on a page of their own, newest first", async () => {
		const user = await publisher();
		const older = await tagged(user, "Older interview", ["interviews", "tools"], { sentAt: new Date(Date.now() - 5 * 86_400_000) });
		const newer = await tagged(user, "Newer interview", ["Interviews"]);
		await tagged(user, "Unrelated", ["tools"]);
		const chips = await renderPost(user, older.issue.archiveSlug);
		assert.match(chips, new RegExp(`<ul aria-label="Tags"[^>]*><li><a href="https://${user.slug}\\.${SHARED_DOMAIN}/tags/interviews"[^>]*>interviews</a></li><li><a href="[^"]*/tags/tools"[^>]*>tools</a></li></ul>`));

		const page = html(await m.tag.default({ ...params(user, { tag: "interviews" }), searchParams: Promise.resolve({}) }), user);
		assert.match(page, /<h1[^>]*>interviews<\/h1>/);
		assert.match(page, /2 issues/);
		assert.ok(page.indexOf("Newer interview") < page.indexOf("Older interview"), "newest first");
		assert.doesNotMatch(page, /Unrelated/);
		assert.match(page, /aria-current="page"[^>]*>interviews</, "the chip of the tag being read");
		assert.ok(newer.issue);
	});

	test("have no page when nobody uses them, or when their issues are unlisted or email only", async () => {
		const user = await publisher();
		const read = (tag) => m.tag.default({ ...params(user, { tag }), searchParams: Promise.resolve({}) });
		assert.equal(await catchNotFound(read("nobody")), true);
		assert.equal(await catchNotFound(read("Bad Tag!")), true);
		const { issue } = await tagged(user, "Hidden", ["secret"]);
		assert.equal(await catchNotFound(read("secret")), false);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: issue._id }, { $set: { archiveListed: false } });
		assert.equal(await catchNotFound(read("secret")), true, "an unlisted issue stays off its tag's page");
	});

	test("are counted for the list of tags, most used first", async () => {
		const user = await publisher();
		await tagged(user, "One", ["b", "a"]);
		await tagged(user, "Two", ["b"]);
		const { body } = await api(user, "GET", "/issue-tags");
		assert.deepEqual(body.tags.map(({ slug, issues }) => [slug, issues]), [["b", 2], ["a", 1]]);
		assert.equal(body.tags[0].url, `https://${user.slug}.${SHARED_DOMAIN}/tags/b`);
	});
});

describe("the paged list of issues", () => {
	async function manyIssues(user, count, prefix = "Issue") {
		for (let index = 0; index < count; index += 1) {
			await addIssue(m, user, { subject: `${prefix} ${String(index).padStart(2, "0")}`, sentAt: new Date(Date.now() - (index + 1) * 3_600_000) });
		}
	}
	const list = (user, query = {}) => m.issues.default({ ...params(user), searchParams: Promise.resolve(query) });
	const titles = (markup) => [...markup.matchAll(/(?:Issue|Match|Other) \d\d/g)].map(([title]) => title);

	test("pages through the issues twelve at a time, newest first, with links between pages", async () => {
		const user = await publisher({ issue: { subject: "Sent issue" } });
		await manyIssues(user, 26);
		const first = html(await list(user), user);
		assert.match(first, /27 issues/);
		// The sent issue the publisher starts with is the newest, so it takes the first of the twelve places.
		assert.deepEqual([...new Set(titles(first))], Array.from({ length: 11 }, (_, index) => `Issue ${String(index).padStart(2, "0")}`));
		assert.match(first, /Sent issue/);
		assert.match(first, /Page 1 of 3/);
		assert.match(first, /rel="next"[^>]*>Older/);
		assert.doesNotMatch(first, /rel="prev"/);

		const second = html(await list(user, { page: "2" }), user);
		assert.match(second, /Page 2 of 3/);
		assert.deepEqual([...new Set(titles(second))][0], "Issue 11");
		assert.match(second, /href="[^"]*\/issues"[^>]*rel="prev"|rel="prev"[^>]*href="[^"]*\/issues"/);
		assert.match(second, /href="[^"]*\/issues\?page=3"/);

		const last = html(await list(user, { page: "3" }), user);
		assert.match(last, /Page 3 of 3/);
		assert.doesNotMatch(last, /rel="next"/);
	});

	test("treats a page that isn't one as the first, and one past the end as the last", async () => {
		const user = await publisher();
		await manyIssues(user, 13);
		for (const page of ["0", "-1", "abc", "1.5", "", "99999999"]) {
			assert.match(html(await list(user, { page }), user), /Page 1 of 2/, page);
		}
		assert.match(html(await list(user, { page: "99" }), user), /Page 2 of 2/);
	});

	test("finds issues by the words in their title, without case, and escapes what was searched for", async () => {
		const user = await publisher();
		await addIssue(m, user, { subject: "Match 01 Pricing a SIDE project" });
		await addIssue(m, user, { subject: "Other 02 Ten tools", previewText: "pricing is in the preview text only" });
		await addIssue(m, user, { subject: "Match 03 pricing again" });
		const found = html(await list(user, { q: "PRICING" }), user);
		assert.deepEqual([...new Set(titles(found))].sort(), ["Match 01", "Match 03"]);
		assert.match(found, /2 issues with “PRICING” in the title/);
		assert.match(found, /<input[^>]*type="search"[^>]*name="q"[^>]*value="PRICING"/);
		assert.match(html(await list(user, { q: "nothing like it" }), user), /No issue has those words in its title\./);

		const hostile = html(await list(user, { q: '"><script>alert(1)</script>' }), user);
		assert.doesNotMatch(hostile, /<script>alert/);
		assert.match(hostile, /&lt;script&gt;/);
		const past = html(await list(user, { q: "pricing", page: "5" }), user);
		assert.match(past, /Match 01/);
		assert.doesNotMatch(past, /aria-label="Pages of issues"/, "one page needs no links between pages");
	});

	test("searches only the newest 500 issues, so a huge archive costs one bounded read", async () => {
		const user = await publisher();
		const { SEARCH_WINDOW } = await import("../lib/archive-data.js");
		assert.equal(SEARCH_WINDOW, 500);
		await m.Campaign.insertMany(
			Array.from({ length: 3 }, (_, index) => ({
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				subject: `Window ${index}`,
				archiveSlug: `window-${index}`,
				status: "sent",
				sentAt: new Date(Date.now() - (index + 1) * 1000),
				format: "rich",
				html: "<p>x</p>",
			}))
		);
		assert.match(html(await list(user, { q: "window" }), user), /3 issues with/);
	});

	test("keeps the home page to the newest twelve and links to the rest", async () => {
		const user = await publisher({ issue: { subject: "Sent issue" } });
		await manyIssues(user, 20);
		const home = html(await m.home(params(user)), user);
		assert.match(home, /All 21 issues →/);
		assert.match(home, new RegExp(`href="https://${user.slug}\\.${SHARED_DOMAIN}/issues"`));
		assert.equal(new Set(titles(home)).size, 12 - 0, "twelve more beside the latest one (Sent issue has no numbered title)");
		const few = await publisher();
		await manyIssues2(few);
		assert.match(html(await m.home(params(few)), few), /Search and tags →/);
	});

	test("keeps pinned issues in a row of their own at the top", async () => {
		const user = await publisher();
		await manyIssues(user, 15);
		const pinned = await addIssue(m, user, { subject: "Pinned very old", archivePinned: true, sentAt: new Date("2020-01-01") });
		const home = html(await m.home(params(user)), user);
		assert.match(home, /Featured/);
		assert.ok(home.indexOf("Pinned very old") < home.indexOf("Issue 00"));
		assert.ok(pinned);
	});
});

describe("the sitemap and robots.txt", () => {
	test("list the published pages, the tags, the list of issues and the issues, and keep crawlers off the reader's pages", async () => {
		const user = await publisher();
		await newPage(user, { title: "About" });
		await newPage(user, { title: "Hidden draft", status: "draft" });
		const issue = await addIssue(m, user, { subject: "With a tag" });
		await api(user, "PATCH", `/campaigns/${issue._id}/archive`, { tags: ["Interviews"] });
		const xml = await (await m.sitemap.GET(new Request("http://x"), params(user))).text();
		const base = `https://${user.slug}.${SHARED_DOMAIN}`;
		for (const path of ["/", "/issues", "/p/about", "/tags/interviews", `/p/${issue.archiveSlug}`]) assert.ok(xml.includes(`<loc>${base}${path}</loc>`), `${path} is in the sitemap`);
		assert.doesNotMatch(xml, /hidden-draft/);
		assert.doesNotMatch(xml, /\/signin|\/account/);

		const robots = await (await m.robots.GET(new Request("http://x"), params(user))).text();
		assert.match(robots, /Disallow: \/signin\nDisallow: \/account/);
		assert.match(robots, /Sitemap: /);
	});
});
