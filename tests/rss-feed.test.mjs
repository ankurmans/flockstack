import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { signIn, startTestApp } from "./helpers/app.mjs";
import { readFixture, serveFeeds } from "./helpers/feeds.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";

// beehiiv parity S12: an RSS block in the editor, read when the issue is built, with the address guarded like a webhook's.

let app;
let m;

const BLOG = "https://blog.example.com/feed.xml";
const ATOM = "https://atom.example.com/feed";
const SENT = `${BLOG}?for=send`;
const block = (url, options = "") => `<div data-rss="${url}" ${options}></div>`;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = {
		...(await loadSendingModules()),
		parse: await import("../lib/feed-parse.js"),
		url: await import("../lib/feed-url.js"),
		render: await import("../lib/feed-render.js"),
		fetch: await import("../lib/feed-fetch.js"),
		resolve: await import("../lib/feed-resolve.js"),
		blocks: await import("../lib/editor-blocks.js"),
		clean: await import("../lib/clean-html.js"),
		email: await import("../lib/render-email.js"),
		archive: await import("../lib/archive-content.js"),
		FeedCache: (await import("../models/FeedCache.js")).default,
	};
});

after(() => app?.stop());

describe("reading a feed", () => {
	test("RSS 2.0: titles, links, dates, excerpts as text, and a picture from the thumbnail, the enclosure or the text", () => {
		const { title, items } = m.parse.parseFeed(readFixture("blog.rss.xml"), BLOG);
		assert.equal(title, "Field Notes & Letters");
		assert.deepEqual(
			items.map(({ title: itemTitle, link, publishedAt, image }) => ({ itemTitle, link, publishedAt, image })),
			[
				{ itemTitle: "Third post: what changed", link: "https://blog.example.com/third", publishedAt: "2026-10-21T08:30:00.000Z", image: "https://cdn.example.com/third.jpg" },
				{ itemTitle: "Second post", link: "https://blog.example.com/second", publishedAt: "2026-10-19T09:00:00.000Z", image: "https://blog.example.com/inline.png" },
				{ itemTitle: "First post", link: "https://blog.example.com/first", publishedAt: "2026-10-16T10:00:00.000Z", image: "https://cdn.example.com/first.png" },
				{ itemTitle: "Undated post", link: "https://blog.example.com/undated", publishedAt: null, image: null },
			]
		);
		assert.equal(items[0].excerpt, "The third post, with markup and a link in its summary.");
		assert.equal(items[1].excerpt, "A plain summary & its ampersand.");
		assert.equal(items[0].id, "post-3");
	});

	test("Atom: the alternate link, published before updated, a summary or the content as text", () => {
		const { title, items } = m.parse.parseFeed(readFixture("news.atom.xml"), ATOM);
		assert.equal(title, "Atom Daily");
		assert.equal(items.length, 2);
		assert.deepEqual(
			[items[0].title, items[0].link, items[0].publishedAt, items[0].excerpt, items[0].id],
			["Entry & two", "https://atom.example.com/two", "2026-10-20T07:00:00.000Z", "Second entry summary.", "tag:atom.example.com,2026:2"]
		);
		assert.deepEqual([items[1].link, items[1].publishedAt, items[1].excerpt, items[1].image], ["https://atom.example.com/one", "2026-10-18T07:00:00.000Z", "First entry body.", "https://atom.example.com/one.jpg"]);
	});

	test("a feed cut off halfway gives the items that were whole; a page that isn't a feed gives none; entities aren't expanded", () => {
		const text = readFixture("blog.rss.xml");
		const cut = text.slice(0, text.indexOf("<title>First post</title>") + 40);
		assert.deepEqual(m.parse.parseFeed(cut).items.map(({ title }) => title), ["Third post: what changed", "Second post"]);
		assert.equal(m.parse.isFeed("<!doctype html><html><body><p>Hello</p></body></html>"), false);
		assert.deepEqual(m.parse.parseFeed("<html></html>").items, []);
		const bomb = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "AAAAAAAAAA">]><rss><channel><title>T</title><item><title>&a;&a;</title><link>https://example.com/x</link></item></channel></rss>';
		assert.equal(m.parse.parseFeed(bomb).items[0].title, "&a;&a;");
	});

	test("links and pictures are http(s) only, and a feed of thousands of items is read to the cap", () => {
		const evil = '<rss><channel><item><title>x</title><link>javascript:alert(1)</link><guid>https://example.com/ok</guid><media:thumbnail url="javascript:alert(2)"/></item></channel></rss>';
		const [item] = m.parse.parseFeed(evil).items;
		assert.equal(item.link, "https://example.com/ok");
		assert.equal(item.image, null);
		const many = `<rss><channel>${"<item><title>t</title><link>https://example.com/a</link></item>".repeat(5000)}</channel></rss>`;
		assert.equal(m.parse.parseFeed(many).items.length, m.parse.MAX_FEED_ITEMS);
	});
});

describe("choosing items", () => {
	test("the newest few, newest or oldest first; undated items follow the dated; since keeps only what is new", () => {
		const all = m.parse.parseFeed(readFixture("blog.rss.xml"), BLOG).items;
		assert.deepEqual(m.render.selectFeedItems(all, { count: 2 }).map(({ id }) => id), ["post-3", "post-2"]);
		assert.deepEqual(m.render.selectFeedItems(all, { count: 2, order: "oldest" }).map(({ id }) => id), ["post-2", "post-3"]);
		assert.deepEqual(m.render.selectFeedItems(all, { count: 10 }).map(({ id }) => id), ["post-3", "post-2", "post-1", "post-0"]);
		assert.deepEqual(m.render.selectFeedItems(all, { count: 10 }, { since: "2026-10-18T00:00:00Z", seenIds: ["post-0"] }).map(({ id }) => id), ["post-3", "post-2"]);
		assert.deepEqual(m.render.selectFeedItems(all, { count: 10 }, { since: "2026-10-18T00:00:00Z", seenIds: [] }).map(({ id }) => id), ["post-3", "post-2", "post-0"]);
	});

	test("an item is printed as a heading with its link, a date, a picture and an excerpt, all escaped", () => {
		const html = m.render.renderFeedItems([{ id: "1", title: 'A "quote" <b>', link: "https://example.com/a?x=1&y=2", publishedAt: "2026-10-21T08:30:00.000Z", excerpt: "Short <script>", image: "https://cdn.example.com/a.jpg" }], {});
		assert.equal(
			html,
			'<img src="https://cdn.example.com/a.jpg" alt="A &quot;quote&quot; &lt;b&gt;"><h3><a href="https://example.com/a?x=1&amp;y=2">A &quot;quote&quot; &lt;b&gt;</a></h3><p><small>Oct 21, 2026</small></p><p>Short &lt;script&gt;</p>'
		);
		const bare = m.render.renderFeedItems([{ id: "1", title: "A", link: "https://example.com/a", publishedAt: "2026-10-21T08:30:00.000Z", excerpt: "E", image: "https://cdn.example.com/a.jpg" }], { image: false, excerpt: false, date: false });
		assert.equal(bare, '<h3><a href="https://example.com/a">A</a></h3>');
		const long = m.render.renderFeedItems([{ id: "1", title: "A", link: null, publishedAt: null, excerpt: "word ".repeat(100), image: null }], { excerptLength: 20 });
		assert.match(long, /<h3>A<\/h3><p>word word word word…<\/p>/);
	});
});

describe("the address guard", () => {
	test("only https on the default port to a public host, with no credentials", () => {
		assert.equal(m.url.getFeedUrlProblem("https://blog.example.com/feed.xml"), null);
		assert.equal(m.url.getFeedUrlProblem("https://93.184.216.34/feed"), null);
		const refused = [
			"",
			"not a url",
			"http://blog.example.com/feed",
			"ftp://blog.example.com/feed",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"https://user:pass@blog.example.com/feed",
			"https://blog.example.com:8443/feed",
			"https://localhost/feed",
			"https://app.localhost/feed",
			"https://intranet/feed",
			"https://metadata.google.internal/computeMetadata/v1/",
			"https://printer.local/feed",
			"https://127.0.0.1/feed",
			"https://10.1.2.3/feed",
			"https://172.16.0.9/feed",
			"https://192.168.1.1/feed",
			"https://169.254.169.254/latest/meta-data/",
			"https://100.64.0.1/feed",
			"https://[::1]/feed",
			"https://[fd00::1]/feed",
			"https://[::ffff:10.0.0.1]/feed",
			"https://0x7f.0.0.1/feed",
			"https://2130706433/feed",
			`https://blog.example.com/${"a".repeat(1000)}`,
		];
		for (const url of refused) assert.ok(m.url.getFeedUrlProblem(url), url);
	});
});

describe("fetching", () => {
	let account;
	let feeds;

	before(async () => {
		account = { _id: (await signIn("feed-fetch@example.com")).accountId };
	});

	function serve(routes) {
		feeds?.restore();
		feeds = serveFeeds(new Map(Object.entries(routes)));
		return feeds;
	}

	after(() => feeds?.restore());

	test("a feed is read, parsed and kept for five minutes, then read again; another account has its own copy", async () => {
		const served = serve({ [BLOG]: readFixture("blog.rss.xml") });
		const first = await m.fetch.fetchFeed({ account, url: BLOG, now: Date.parse("2026-10-21T10:00:00Z") });
		assert.equal(first.cached, false);
		assert.equal(first.items.length, 4);
		assert.equal(served.requests[0].init.redirect, "manual");
		assert.match(served.requests[0].init.headers.accept, /rss\+xml/);

		const again = await m.fetch.fetchFeed({ account, url: BLOG, now: Date.parse("2026-10-21T10:04:00Z") });
		assert.equal(again.cached, true);
		assert.equal(served.requests.length, 1);

		await m.fetch.fetchFeed({ account, url: BLOG, now: Date.parse("2026-10-21T10:06:00Z") });
		assert.equal(served.requests.length, 2);

		const other = { _id: (await signIn("feed-fetch-other@example.com")).accountId };
		await m.fetch.fetchFeed({ account: other, url: BLOG, now: Date.parse("2026-10-21T10:06:30Z") });
		assert.equal(served.requests.length, 3);
	});

	test("a feed that fails answers with the copy from the last hour, and with the error after that", async () => {
		const down = serve({ [ATOM]: readFixture("news.atom.xml") });
		const now = Date.parse("2026-10-21T10:00:00Z");
		await m.fetch.fetchFeed({ account, url: ATOM, now });
		feeds.restore();
		serve({ [ATOM]: { status: 500 } });
		const stale = await m.fetch.fetchFeed({ account, url: ATOM, now: now + 20 * 60_000 });
		assert.equal(stale.stale, true);
		assert.equal(stale.items.length, 2);
		await assert.rejects(m.fetch.fetchFeed({ account, url: ATOM, now: now + 90 * 60_000 }), { code: "validation_failed", message: "The feed answered 500" });
		assert.equal(down.requests.length, 1);
	});

	test("an address the guard refuses is never requested, and neither is a redirect to one", async () => {
		const served = serve({
			"https://redirect.example.com/feed": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } },
			"https://loop.example.com/feed": { status: 301, headers: { location: "https://loop.example.com/feed" } },
			"https://hop.example.com/a": { status: 301, headers: { location: "/b" } },
			"https://hop.example.com/b": readFixture("news.atom.xml"),
			"https://downgrade.example.com/feed": { status: 301, headers: { location: "http://downgrade.example.com/feed" } },
		});
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://127.0.0.1/feed" }), { code: "validation_failed" });
		await assert.rejects(m.fetch.fetchFeed({ account, url: "http://blog.example.com/feed" }), { code: "validation_failed" });
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://redirect.example.com/feed" }), /redirects to an address FlockStack can't read/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://downgrade.example.com/feed" }), /redirects to an address/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://loop.example.com/feed" }), /redirects too many times/);
		assert.deepEqual(served.requests.filter(({ url }) => url.includes("169.254")).length, 0);
		const followed = await m.fetch.fetchFeed({ account, url: "https://hop.example.com/a" });
		assert.equal(followed.items.length, 2);
	});

	test("a feed over 1 MB, a page that isn't a feed, and a server that doesn't answer in time are refused with a reason", async () => {
		serve({
			"https://big.example.com/feed": `<rss><channel>${"<!-- ".padEnd(1_100_000, "x")} --></channel></rss>`,
			"https://big-header.example.com/feed": { headers: { "content-length": "5000000" }, body: "<rss></rss>" },
			"https://page.example.com/feed": { headers: { "content-type": "text/html" }, body: "<html><body>Hello</body></html>" },
			"https://slow.example.com/feed": () => {
				throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
			},
			"https://down.example.com/feed": () => {
				throw new TypeError("fetch failed");
			},
		});
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://big.example.com/feed" }), /too large/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://big-header.example.com/feed" }), /too large/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://page.example.com/feed" }), /isn't an RSS or Atom feed/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://slow.example.com/feed" }), /took too long/);
		await assert.rejects(m.fetch.fetchFeed({ account, url: "https://down.example.com/feed" }), /could not be reached/);
	});

	test("the hourly job drops copies nobody read for a day", async () => {
		const old = "https://old.example.com/feed";
		serve({ [old]: readFixture("blog.rss.xml") });
		await m.fetch.fetchFeed({ account, url: old, now: Date.parse("2026-01-01T00:00:00Z") });
		assert.equal(await m.FeedCache.countDocuments({ key: old }).setOptions({ crossAccount: true }), 1);
		assert.ok((await m.fetch.purgeOldFeeds(Date.parse("2026-01-03T00:00:00Z"))) >= 1);
		assert.equal(await m.FeedCache.countDocuments({ key: old }).setOptions({ crossAccount: true }), 0);
	});
});

describe("the block", () => {
	test("the cleaner keeps its settings checked and rebuilt, and drops a block whose address it wouldn't fetch", () => {
		const html = m.clean.cleanRichHtml(`<p>Intro</p><div data-rss="${BLOG}" data-count="50" data-order="sideways" data-image="0" onclick="x()" style="color:red"></div>`);
		assert.equal(html, `<p>Intro</p><div data-rss="${BLOG}" data-count="3" data-order="newest" data-image="0" data-excerpt="1" data-date="1"></div>`);
		assert.equal(m.clean.cleanRichHtml(`<div data-rss="http://blog.example.com/feed" data-count="2"></div>`), "<div></div>");
		assert.equal(m.clean.cleanRichHtml(`<div data-rss="https://127.0.0.1/feed"></div>`), "<div></div>");
		assert.equal(m.clean.cleanRichHtml(`<div data-rss="javascript:alert(1)"></div>`), "<div></div>");
		assert.equal(m.clean.cleanRichHtml(`<div data-rss="https://blog.example.com/feed?a=1&amp;b=&quot;2"></div>`), '<div data-rss="https://blog.example.com/feed?a=1&amp;b=%222" data-count="3" data-order="newest" data-image="1" data-excerpt="1" data-date="1"></div>');
	});

	test("an email shows a stand-in for a block that wasn't read yet, a web page shows nothing, and a block counts as content", () => {
		const body = block(BLOG, 'data-count="2"');
		const { html } = m.email.renderEmail({ format: "rich", html: body, subject: "S", newsletter: { name: "N" } });
		assert.match(html, /The latest 2 items from blog\.example\.com/);
		assert.match(html, /Read when the issue goes out/);
		assert.equal(m.blocks.renderWebBlocks(body), "");
		assert.equal(m.archive.renderIssueBody({ format: "rich", html: body, audience: "all" }).html.includes("blog.example.com"), false);
		assert.equal(m.email.hasContent(body), true);
		assert.equal(m.email.hasContent("<p></p>"), false);
		assert.deepEqual(m.blocks.findFeedBlocks(`<p>a</p>${body}${block("https://127.0.0.1/x")}`).map(({ options }) => options?.url ?? null), [BLOG, null]);
	});

	test("resolving replaces each block with its items, and a block with nothing new with nothing", async () => {
		const account = { _id: (await signIn("feed-resolve@example.com")).accountId };
		const served = serveFeeds(new Map([[BLOG, readFixture("blog.rss.xml")], [ATOM, readFixture("news.atom.xml")]]));
		try {
			const html = `<p>Before</p>${block(BLOG, 'data-count="2" data-image="0" data-excerpt="0"')}<p>Middle</p>${block(ATOM, 'data-count="1" data-order="oldest"')}${block(BLOG)}<p>After</p>`;
			const { html: resolved, items } = await m.resolve.resolveFeedBlocks(html, { account });
			assert.ok(!resolved.includes("data-rss"));
			assert.deepEqual(items.map(({ id }) => id), ["post-3", "post-2", "tag:atom.example.com,2026:2", "post-3", "post-2", "post-1"]);
			assert.match(resolved, /^<p>Before<\/p><h3><a href="https:\/\/blog\.example\.com\/third">Third post: what changed<\/a><\/h3><p><small>Oct 21, 2026<\/small><\/p><hr><h3>/);
			assert.match(resolved, /<\/h3><p><small>Oct 19, 2026<\/small><\/p><p>Middle<\/p>/);
			assert.ok(resolved.endsWith("<p>After</p>"));
			assert.equal(served.requests.length, 2, "each feed once, however many blocks");

			const nothing = await m.resolve.resolveFeedBlocks(block(BLOG), { account, since: "2026-12-01T00:00:00Z", seenIds: ["post-0"] });
			assert.deepEqual([nothing.html, nothing.items], ["", []]);
			assert.equal((await m.resolve.resolveFeedBlocks("<p>No block</p>", { account })).html, "<p>No block</p>");
			assert.equal(m.resolve.hasFeedBlocks("<p>No block</p>"), false);
		} finally {
			served.restore();
		}
	});
});

describe("sending an issue with a feed block", () => {
	let user;
	let feeds;

	before(async () => {
		user = await setupSender(m, "feed-sender@example.com", { contacts: 2 });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
		feeds = serveFeeds(new Map([[BLOG, readFixture("blog.rss.xml")], [SENT, readFixture("blog.rss.xml")]]));
	});

	after(() => feeds?.restore());

	test("a test email reads the feed and the draft keeps its block", async () => {
		const campaignId = await createDraft(m, user, { subject: "From the feed", body: `<p>Hello</p>${block(BLOG, 'data-count="2"')}` });
		await act(m, user, "send_test_email", { id: campaignId, to: ["proof@example.net"] });
		const [email] = sent.filter(({ to }) => to === "proof@example.net");
		assert.match(email.html, /Third post: what changed/);
		assert.match(email.html, /Second post/);
		assert.doesNotMatch(email.html, /First post/);
		assert.doesNotMatch(email.html, /Read when the issue goes out/);
		assert.match((await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean()).html, /data-rss=/);
	});

	test("sending reads the feed once, saves the items in the issue and gives every reader the same email and page", async () => {
		const campaignId = await createDraft(m, user, { subject: "Sent from the feed", body: `<p>Hello</p>${block(SENT, 'data-count="1"')}` });
		const before = feeds.requests.length;
		await act(m, user, "send_campaign", { id: campaignId });
		await runJobs(sendRoutes(m));
		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
		assert.ok(!stored.html.includes("data-rss"));
		assert.match(stored.html, /Third post: what changed/);
		assert.equal(feeds.requests.length - before, 1);
		for (const reader of ["reader0", "reader1"]) {
			const [email] = sent.filter(({ to }) => to === `${reader}@feed-sender.example.org`);
			assert.match(email.html, /Third post: what changed/, reader);
		}
		const page = m.archive.renderIssueBody(stored, {});
		assert.match(page.html, /Third post: what changed/);
	});

	test("a feed that can't be read stops the send before it starts and leaves the draft as it was", async () => {
		const campaignId = await createDraft(m, user, { subject: "Broken feed", body: block("https://broken.example.com/feed") });
		feeds.restore();
		feeds = serveFeeds(new Map([["https://broken.example.com/feed", { status: 503 }], [BLOG, readFixture("blog.rss.xml")]]));
		await assert.rejects(act(m, user, "send_campaign", { id: campaignId }), { code: "send_check_failed", message: /RSS block's feed couldn't be read: The feed answered 503/ });
		const draft = await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
		assert.equal(draft.status, "draft");
		assert.match(draft.html, /data-rss=/);
		await assert.rejects(act(m, user, "send_test_email", { id: campaignId }), { code: "send_check_failed" });
	});

	test("a web only issue is read the same way, as it is published", async () => {
		const campaignId = await createDraft(m, user, { subject: "On the web from the feed", body: block(BLOG, 'data-count="1"') });
		await act(m, user, "update_campaign", { id: campaignId, publishTo: "web" });
		await act(m, user, "send_campaign", { id: campaignId });
		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
		assert.equal(stored.status, "sent");
		assert.match(stored.html, /Third post: what changed/);
		assert.ok(!stored.html.includes("data-rss"));
	});

	test("preview_feed answers the block's items through the API, and refuses an address the guard refuses", async () => {
		const preview = await act(m, user, "preview_feed", { url: BLOG, count: 2, order: "oldest" });
		assert.equal(preview.title, "Field Notes & Letters");
		assert.deepEqual(preview.items.map(({ title }) => title), ["Second post", "Third post: what changed"]);
		assert.equal(preview.items[1].image, "https://cdn.example.com/third.jpg");
		await assert.rejects(act(m, user, "preview_feed", { url: "https://127.0.0.1/feed" }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "preview_feed", { url: "http://blog.example.com/feed.xml" }), { code: "validation_failed" });
	});
});
