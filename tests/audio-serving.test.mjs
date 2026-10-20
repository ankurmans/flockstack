import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryObjects } from "../lib/export-storage.js";
import { parseRange } from "../lib/audio-serve.js";
import { addIssue, addReader, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";
import { anonymous, as, callApi, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { childOf, childrenOf, lintXml, parseXml, textOf } from "./helpers/xml.mjs";
import { resetVoice } from "./stubs/elevenlabs.mjs";
import { files } from "./stubs/opennext-cloudflare.mjs";
import { published } from "./stubs/qstash.mjs";

// What listeners get: the file with byte ranges, who may hear it, the podcast feed, the link in the email, the player on
// the page, and the event.

const VOICES = [{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm and clear", previewUrl: "https://example.com/rachel.mp3" }];
const SHARED_DOMAIN = "flockstackmail.com";

let app;
let m;
let counter = 0;
let processed = 0;

before(async () => {
	app = await startTestApp({
		EXPORT_STORAGE: "memory",
		QSTASH_CURRENT_SIGNING_KEY: "sig-current",
		QSTASH_NEXT_SIGNING_KEY: "sig-next",
		ELEVENLABS_API_KEY: "xi-test-key",
		ELEVENLABS_VOICES: JSON.stringify(VOICES),
		AUDIO_ENABLED: "true",
		ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-01-01",
	});
	m = {
		...(await importModels()),
		jobRoute: await import("../app/api/jobs/make-audio/route.js"),
		audioRoute: await import("../app/archive/[slug]/audio/[post]/route.js"),
		podcastRoute: await import("../app/archive/[slug]/podcast/route.js"),
		dashboardAudioRoute: await import("../app/api/audio/[id]/route.js"),
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		storage: await import("../lib/audio-storage.js"),
		feed: await import("../lib/audio-feed.js"),
		hosts: await import("../lib/archive-hosts.js"),
		events: await import("../lib/webhook-events.js"),
		docs: await import("../lib/docs/llms.js"),
		reference: await import("../lib/docs/reference.js"),
		plans: await import("../lib/plans.js"),
		docsPage: await import("../app/(site)/docs/audio/page.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		AudioVersion: (await import("../models/AudioVersion.js")).default,
		WebhookDelivery: (await import("../models/WebhookDelivery.js")).default,
	};
	processed = published.length;
});

after(() => app?.stop());
beforeEach(() => resetVoice());

const sentence = (index) => `Sentence number ${index} is here to be read aloud by the voice. `;
const paragraphs = (count, offset = 0) => Array.from({ length: count }, (_, index) => `<p>${Array.from({ length: 14 }, (__, i) => sentence(offset + index * 14 + i)).join("").trim()}</p>`).join("");

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });
const idOf = (issue) => String(issue._id);

async function runJobs() {
	while (processed < published.length) {
		const job = published[processed++];
		if (!job.url.endsWith("/api/jobs/make-audio")) continue;
		const response = await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
		assert.ok(response.status < 400, await response.text());
	}
}

async function publisher(options = {}) {
	const user = await createPublisher(m, `serve${++counter}@example.com`, { issue: { subject: "The long weekend", html: paragraphs(3) }, ...options });
	return user;
}

async function audioFor(user, issue = user.issue, input = {}) {
	const created = await api(user, "POST", "/audio-versions", { campaign: idOf(issue), ...input });
	assert.equal(created.status, 202, JSON.stringify(created.body));
	await runJobs();
	const { audio } = (await api(user, "GET", `/audio-versions/${idOf(issue)}`)).body;
	assert.equal(audio.status, "ready", audio.error);
	return audio;
}

function getAudio(user, issue, { headers = {}, method = "GET", query = "", visitor = null } = {}) {
	const request = new Request(`https://${user.slug}.${SHARED_DOMAIN}/audio/${issue.archiveSlug}.mp3${query}`, { method, headers });
	const run = () => m.audioRoute.GET(request, { params: Promise.resolve({ slug: user.slug, post: issue.archiveSlug }) });
	return visitor ? inBrowser(visitor, run) : anonymous(run);
}

async function podcast(user, headers = {}) {
	return anonymous(() => m.podcastRoute.GET(new Request("https://x.example.com/podcast.xml", { headers }), { params: Promise.resolve({ slug: user.slug }) }));
}

const bytesOf = async (response) => new Uint8Array(await response.arrayBuffer());

describe("byte ranges", () => {
	test("are read as the HTTP specification has them, and ignored when they can't be answered with one piece", () => {
		assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
		assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
		assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
		assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "an end past the file stops at it");
		assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
		assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
		assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
		for (const ignored of [null, "", "bytes=0-1,5-9", "items=0-9", "bytes=", "bytes=9-3", "nonsense"]) assert.equal(parseRange(ignored, 1000), null, String(ignored));
	});
});

describe("the audio file", () => {
	test("is served to anyone for an issue everyone reads, with the headers podcast apps and iOS need", async () => {
		const user = await publisher();
		const audio = await audioFor(user);
		const full = await getAudio(user, user.issue);
		assert.equal(full.status, 200);
		const body = await bytesOf(full);
		assert.equal(body.length, audio.file.bytes);
		assert.equal(full.headers.get("content-type"), "audio/mpeg");
		assert.equal(full.headers.get("accept-ranges"), "bytes");
		assert.equal(full.headers.get("content-length"), String(audio.file.bytes));
		assert.match(full.headers.get("etag"), /^"[a-z0-9]+-\d+"$/);
		assert.equal(full.headers.get("cache-control"), "public, max-age=3600");
		assert.equal(full.headers.get("x-content-type-options"), "nosniff");
		assert.match(full.headers.get("last-modified"), /GMT$/);

		const versioned = await getAudio(user, user.issue, { query: new URL(audio.file.url).search });
		assert.equal(versioned.headers.get("cache-control"), "public, max-age=31536000, immutable", "an address with the file's version never changes");
		await versioned.arrayBuffer();
	});

	test("answers a range with the piece asked for and Content-Range, the last bytes of a suffix, and the rest from an offset", async () => {
		const user = await publisher();
		const { file } = await audioFor(user);
		const whole = await bytesOf(await getAudio(user, user.issue));

		const first = await getAudio(user, user.issue, { headers: { range: "bytes=0-99" } });
		assert.equal(first.status, 206);
		assert.equal(first.headers.get("content-range"), `bytes 0-99/${file.bytes}`);
		assert.equal(first.headers.get("content-length"), "100");
		assert.deepEqual(await bytesOf(first), whole.subarray(0, 100));

		const middle = await getAudio(user, user.issue, { headers: { range: "bytes=1000-1999" } });
		assert.equal(middle.status, 206);
		assert.deepEqual(await bytesOf(middle), whole.subarray(1000, 2000));

		const suffix = await getAudio(user, user.issue, { headers: { range: "bytes=-50" } });
		assert.equal(suffix.headers.get("content-range"), `bytes ${file.bytes - 50}-${file.bytes - 1}/${file.bytes}`);
		assert.deepEqual(await bytesOf(suffix), whole.subarray(file.bytes - 50));

		const open = await getAudio(user, user.issue, { headers: { range: `bytes=${file.bytes - 10}-` } });
		assert.equal(open.status, 206);
		assert.equal((await bytesOf(open)).length, 10);

		// iOS probes with the first two bytes.
		const probe = await getAudio(user, user.issue, { headers: { range: "bytes=0-1" } });
		assert.equal(probe.status, 206);
		assert.equal((await bytesOf(probe)).length, 2);
	});

	test("refuses a range past the end with 416 and the file's size, and sends the whole file for several ranges, a unit it doesn't know or a stale If-Range", async () => {
		const user = await publisher();
		const { file } = await audioFor(user);
		const past = await getAudio(user, user.issue, { headers: { range: `bytes=${file.bytes}-` } });
		assert.equal(past.status, 416);
		assert.equal(past.headers.get("content-range"), `bytes */${file.bytes}`);
		for (const headers of [{ range: "bytes=0-5,10-15" }, { range: "pages=1-2" }, { range: "bytes=0-9", "if-range": '"some-other-version"' }]) {
			const response = await getAudio(user, user.issue, { headers });
			assert.equal(response.status, 200, JSON.stringify(headers));
			assert.equal((await bytesOf(response)).length, file.bytes);
		}
		const etag = (await getAudio(user, user.issue)).headers.get("etag");
		const current = await getAudio(user, user.issue, { headers: { range: "bytes=0-9", "if-range": etag } });
		assert.equal(current.status, 206, "an If-Range that is still current gets its range");
		await current.arrayBuffer();
	});

	test("answers HEAD without a body, and 304 to a validator that still holds", async () => {
		const user = await publisher();
		const { file } = await audioFor(user);
		const head = await getAudio(user, user.issue, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), String(file.bytes));
		assert.equal((await bytesOf(head)).length, 0);
		const partialHead = await getAudio(user, user.issue, { method: "HEAD", headers: { range: "bytes=0-9" } });
		assert.equal(partialHead.status, 206);
		assert.equal(partialHead.headers.get("content-length"), "10");
		const etag = head.headers.get("etag");
		const notModified = await getAudio(user, user.issue, { headers: { "if-none-match": etag } });
		assert.equal(notModified.status, 304);
		assert.equal((await bytesOf(notModified)).length, 0);
	});

	test("is not there for a draft, an issue without audio, or a newsletter that doesn't exist", async () => {
		const user = await publisher();
		const draft = await addIssue(m, user, { subject: "Draft", status: "draft", html: paragraphs(2) });
		await audioFor(user, draft);
		assert.equal((await getAudio(user, draft)).status, 404, "a draft has no page, so no public audio");
		assert.equal((await getAudio(user, user.issue)).status, 404, "an issue nobody made audio for");
		const response = await anonymous(() => m.audioRoute.GET(new Request("http://x.example.com/a"), { params: Promise.resolve({ slug: "no-such-newsletter", post: "x" }) }));
		assert.equal(response.status, 404);
		// The writer plays a draft's audio in the dashboard.
		const own = await as(user, () => m.dashboardAudioRoute.GET(new Request("http://localhost:3000/api/audio/x", { headers: { range: "bytes=0-9" } }), { params: Promise.resolve({ id: idOf(draft) }) }));
		assert.equal(own.status, 206);
		assert.match(own.headers.get("cache-control"), /^private/);
		await own.arrayBuffer();
	});

	test("the dashboard's copy is for its account alone", async () => {
		const user = await publisher();
		const other = await publisher();
		await audioFor(user);
		const call = (who) => who(() => m.dashboardAudioRoute.GET(new Request("http://localhost:3000/api/audio/x"), { params: Promise.resolve({ id: idOf(user.issue) }) }));
		assert.equal((await call(anonymous)).status, 401);
		assert.equal((await call((run) => as(other, run))).status, 404);
		assert.equal((await call((run) => as(user, run))).status, 200);
		assert.equal((await as(user, () => m.dashboardAudioRoute.GET(new Request("http://x"), { params: Promise.resolve({ id: "not-an-id" }) }))).status, 404);
	});

	test("reaches the newsletter's host through the proxy at /audio/<slug>.mp3", async () => {
		const user = await publisher();
		const url = `https://${user.slug}.${SHARED_DOMAIN}/audio/${user.issue.archiveSlug}.mp3`;
		const rewritten = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
		assert.match(rewritten.headers.get("x-middleware-rewrite"), new RegExp(`/archive/${user.slug}/audio/${user.issue.archiveSlug}$`));
		const feed = await m.proxy(new m.NextRequest(`https://${user.slug}.${SHARED_DOMAIN}/podcast.xml`, { headers: { host: `${user.slug}.${SHARED_DOMAIN}` } }));
		assert.match(feed.headers.get("x-middleware-rewrite"), new RegExp(`/archive/${user.slug}/podcast$`));
		const urls = m.hosts.getArchiveUrls(user.newsletter);
		assert.equal(urls.absoluteAudio("a-post"), `https://${user.slug}.${SHARED_DOMAIN}/audio/a-post.mp3`);
		assert.equal(urls.podcast, `https://${user.slug}.${SHARED_DOMAIN}/podcast.xml`);
		assert.equal(m.hosts.getArchiveHostUrl(`/archive/${user.slug}/audio/a-post`), `https://${user.slug}.${SHARED_DOMAIN}/audio/a-post.mp3`);
		assert.equal(m.hosts.getArchiveHostUrl(`/archive/${user.slug}/podcast`), `https://${user.slug}.${SHARED_DOMAIN}/podcast.xml`);
	});
});

describe("audio for paid readers", () => {
	const MIXED = `<p>Free words here.</p><div data-paywall=""></div><p>Paid secret words.</p>`;

	async function paidSetup() {
		const user = await publisher();
		const paidIssue = await addIssue(m, user, { subject: "For members", audience: "paid", html: MIXED });
		const paid = await addReader(m, user, "member@example.org", { tier: "paid", paidUntil: new Date(Date.now() + 30 * 86_400_000) });
		const free = await addReader(m, user, "free@example.org");
		return { user, paidIssue, paidVisitor: await signInReader(m, user, paid, { issue: paidIssue }), freeVisitor: await signInReader(m, user, free, { issue: paidIssue }) };
	}

	test("an issue for paid subscribers only is read whole, and heard by paid readers only", async () => {
		const { user, paidIssue, paidVisitor, freeVisitor } = await paidSetup();
		const audio = await audioFor(user, paidIssue);
		assert.equal(audio.scope, "paid");
		assert.equal(audio.file.url, null, "there is no public address for it");
		assert.match(JSON.stringify((await import("./stubs/elevenlabs.mjs")).requests.map(({ text }) => text)), /Paid secret words/);

		const visitor = await getAudio(user, paidIssue);
		assert.equal(visitor.status, 401);
		assert.equal(visitor.headers.get("cache-control"), "private, no-store");
		assert.equal((await getAudio(user, paidIssue, { visitor: freeVisitor })).status, 403, "a free subscriber is signed in, and not paid");
		const heard = await getAudio(user, paidIssue, { visitor: paidVisitor, headers: { range: "bytes=0-99" } });
		assert.equal(heard.status, 206);
		assert.match(heard.headers.get("cache-control"), /^private/);
		assert.equal(heard.headers.get("vary"), "Cookie");
		assert.equal((await bytesOf(heard)).length, 100);
		const lapsed = await addReader(m, user, "lapsed@example.org", { tier: "paid", paidUntil: new Date(Date.now() - 30 * 86_400_000) });
		assert.equal((await getAudio(user, paidIssue, { visitor: await signInReader(m, user, lapsed, { issue: paidIssue }) })).status, 403, "a paid reader whose period ran out");
	});

	test("the audio of an issue with a paywall break stops at it, and is public", async () => {
		const user = await publisher();
		const mixed = await addIssue(m, user, { subject: "Mixed", html: MIXED });
		const audio = await audioFor(user, mixed);
		assert.equal(audio.scope, "public");
		const { requests } = await import("./stubs/elevenlabs.mjs");
		const text = requests.map((request) => request.text).join(" ");
		assert.match(text, /Free words here/);
		assert.doesNotMatch(text, /Paid secret words/);
		assert.match(text, /The rest of this issue is for paid subscribers\./);
		assert.equal((await getAudio(user, mixed)).status, 200);
	});

	test("an issue that became paid after its audio was made is paid-only audio from then on", async () => {
		const { user, paidVisitor } = await paidSetup();
		const issue = await addIssue(m, user, { subject: "Was free", html: paragraphs(2) });
		await audioFor(user, issue);
		assert.equal((await getAudio(user, issue)).status, 200);
		await m.Campaign.updateOne({ accountId: user.accountId, _id: issue._id }, { $set: { audience: "paid" } });
		assert.equal((await getAudio(user, issue)).status, 401);
		assert.equal((await getAudio(user, issue, { visitor: paidVisitor })).status, 200);
		const feedXml = await (await podcastOn(user)).text();
		assert.doesNotMatch(feedXml, /Was free/);
	});
});

async function podcastOn(user, settings = {}) {
	const set = await api(user, "PATCH", "/audio-settings", { podcastEnabled: true, ...settings });
	assert.equal(set.status, 200, JSON.stringify(set.body));
	return podcast(user);
}

describe("the podcast feed", () => {
	test("is valid RSS 2.0 with the iTunes tags, an enclosure with its length and type for each episode, and the logo as cover art", async () => {
		const user = await publisher({ newsletter: {} });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { imageUrl: "https://example.com/logo.png", description: "A weekly note & more" } });
		const second = await addIssue(m, user, { subject: 'Q&A: "quotes" <b>', previewText: "Second one's preview", html: paragraphs(2), sentAt: new Date(Date.now() + 60_000) });
		const firstAudio = await audioFor(user);
		const secondAudio = await audioFor(user, second);

		const response = await podcastOn(user, { podcastCategory: "Business", podcastExplicit: true, podcastOwnerEmail: "owner@example.com" });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
		assert.equal(response.headers.get("cache-control"), "public, max-age=300, s-maxage=900, stale-while-revalidate=86400");
		const xml = await response.text();

		const root = parseXml(xml);
		const lint = lintXml(xml);
		if (lint) assert.ok(lint.ok, lint.stderr);
		assert.equal(root.name, "rss");
		assert.equal(root.attributes.version, "2.0");
		assert.equal(root.attributes["xmlns:itunes"], "http://www.itunes.com/dtds/podcast-1.0.dtd");
		const channel = childOf(root, "channel");
		assert.equal(textOf(channel, "title"), user.newsletter.name);
		assert.equal(textOf(channel, "link"), `https://${user.slug}.${SHARED_DOMAIN}/`);
		assert.equal(textOf(channel, "description"), "A weekly note & more");
		assert.equal(textOf(channel, "language"), "en");
		assert.match(textOf(channel, "lastBuildDate"), /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
		assert.equal(childOf(channel, "atom:link").attributes.href, `https://${user.slug}.${SHARED_DOMAIN}/podcast.xml`);
		assert.equal(childOf(channel, "atom:link").attributes.rel, "self");
		assert.equal(textOf(channel, "itunes:explicit"), "true");
		assert.equal(textOf(channel, "itunes:type"), "episodic");
		assert.equal(textOf(channel, "itunes:author"), user.newsletter.fromName || user.newsletter.name);
		assert.equal(childOf(channel, "itunes:image").attributes.href, "https://example.com/logo.png");
		assert.equal(childOf(channel, "itunes:category").attributes.text, "Business");
		assert.equal(textOf(childOf(channel, "itunes:owner"), "itunes:email"), "owner@example.com");

		const items = childrenOf(channel, "item");
		assert.equal(items.length, 2);
		const [newest, oldest] = items;
		assert.equal(textOf(newest, "title"), 'Q&A: "quotes" <b>', "newest first, escaped and unescaped again by the parser");
		assert.equal(textOf(newest, "description"), "Second one's preview");
		assert.equal(textOf(oldest, "title"), "The long weekend");
		for (const [item, issue, audio] of [[newest, second, secondAudio], [oldest, user.issue, firstAudio]]) {
			const enclosure = childOf(item, "enclosure");
			assert.equal(enclosure.attributes.url, `https://${user.slug}.${SHARED_DOMAIN}/audio/${issue.archiveSlug}.mp3`);
			assert.equal(enclosure.attributes.length, String(audio.file.bytes));
			assert.equal(enclosure.attributes.type, "audio/mpeg");
			assert.match(textOf(item, "itunes:duration"), /^\d{2}:\d{2}:\d{2}$/);
			assert.equal(textOf(item, "guid"), `flockstack-audio:${idOf(issue)}`);
			assert.equal(childOf(item, "guid").attributes.isPermaLink, "false");
			assert.equal(textOf(item, "link"), `https://${user.slug}.${SHARED_DOMAIN}/p/${issue.archiveSlug}`);
			assert.match(textOf(item, "pubDate"), /GMT$/);
			assert.equal(textOf(item, "itunes:episodeType"), "full");
		}
		assert.equal(m.feed.formatDuration(724), "00:12:04");
		assert.equal(m.feed.formatDuration(3725), "01:02:05");

		// Each enclosure plays, with ranges.
		const url = new URL(childOf(oldest, "enclosure").attributes.url);
		assert.equal(url.search, "");
	});

	test("is 404 until the owner turns it on, and revalidates with its ETag", async () => {
		const user = await publisher();
		await audioFor(user);
		assert.equal((await podcast(user)).status, 404);
		const on = await podcastOn(user);
		assert.equal(on.status, 200);
		const etag = on.headers.get("etag");
		assert.ok(etag);
		await on.text();
		const again = await podcast(user, { "if-none-match": etag });
		assert.equal(again.status, 304);
		assert.equal(await again.text(), "");
		await api(user, "PATCH", "/audio-settings", { podcastEnabled: false });
		assert.equal((await podcast(user)).status, 404);
	});

	test("has only the public episodes: not an issue for paid subscribers only, an unlisted or email-only one, or a draft", async () => {
		const user = await publisher();
		const paid = await addIssue(m, user, { subject: "Members only episode", audience: "paid", html: paragraphs(1) });
		const unlisted = await addIssue(m, user, { subject: "Unlisted episode", archiveListed: false, html: paragraphs(1) });
		const emailOnly = await addIssue(m, user, { subject: "Email only episode", publishTo: "email", html: paragraphs(1) });
		const draft = await addIssue(m, user, { subject: "Draft episode", status: "draft", html: paragraphs(1) });
		const free = await addIssue(m, user, { subject: "Free for all", audience: "free", html: paragraphs(1) });
		for (const issue of [user.issue, paid, unlisted, emailOnly, draft, free]) await audioFor(user, issue);

		const xml = await (await podcastOn(user)).text();
		parseXml(xml);
		assert.match(xml, /The long weekend/);
		assert.match(xml, /Free for all/);
		for (const hidden of ["Members only episode", "Unlisted episode", "Email only episode", "Draft episode"]) assert.doesNotMatch(xml, new RegExp(hidden), hidden);
		assert.equal(m.feed.isPublicEpisode({ issue: { audience: "paid", archiveSlug: "x" }, audio: { file: { scope: "public", key: "k" } } }), false);
		assert.equal(m.feed.isPublicEpisode({ issue: { audience: "all", archiveSlug: "x" }, audio: { file: { scope: "paid", key: "k" } } }), false);
		assert.equal(m.feed.isPublicEpisode({ issue: { audience: "all", access: "paid", archiveSlug: "x" }, audio: { file: { scope: "public", key: "k" } } }), false);
	});

	test("drops an episode whose audio was deleted, and is empty but valid with none", async () => {
		const user = await publisher();
		await audioFor(user);
		const before = parseXml(await (await podcastOn(user)).text());
		assert.equal(childrenOf(childOf(before, "channel"), "item").length, 1);
		await api(user, "DELETE", `/audio-versions/${idOf(user.issue)}`);
		const after = parseXml(await (await podcast(user)).text());
		assert.equal(childrenOf(childOf(after, "channel"), "item").length, 0);
		assert.equal(childOf(childOf(after, "channel"), "lastBuildDate"), null);
	});

	test("escapes what a title or a name can hold, and has no owner or cover art unless they are set", async () => {
		const user = await publisher();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { name: 'Tom & Jerry\'s <"show">' } });
		const tricky = await addIssue(m, user, { subject: "Fish & chips \u0001 <script>", html: paragraphs(1) });
		await audioFor(user, tricky);
		const xml = await (await podcastOn(user)).text();
		const channel = childOf(parseXml(xml), "channel");
		assert.equal(textOf(channel, "title"), 'Tom & Jerry\'s <"show">');
		assert.match(xml, /Fish &amp; chips  &lt;script&gt;/);
		assert.equal(childOf(channel, "itunes:owner"), null);
		assert.equal(childOf(channel, "itunes:image"), null);
		assert.doesNotMatch(xml, /[\u0000-\u0008]/);
	});
});

describe("the strict XML check", () => {
	test("refuses what a real parser would", () => {
		const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
		assert.ok(parseXml(`${head}<a x="1"><b>t &amp; u</b><c/></a>`));
		for (const bad of [
			`${head}<a><b></a>`,
			`${head}<a>fish & chips</a>`,
			`${head}<a x=1></a>`,
			`${head}<a x="1" x="2"/>`,
			`${head}<a><p:b/></a>`,
			`${head}<a>1 < 2</a>`,
			`${head}<a/><b/>`,
			`<a/>`,
			`${head}<a>\u0001</a>`,
			`${head}<a>text</a>after`,
		]) {
			assert.throws(() => parseXml(bad), bad);
		}
	});
});

describe("the Listen link in the email", () => {
	test("opens the issue's emails when its writer ticked it, with the length, and goes when they untick it", async () => {
		const user = await publisher();
		const contact = await addReader(m, user, "reader@example.org");
		const ready = await audioFor(user, user.issue, { emailLink: true });
		const minutes = Math.max(1, Math.round(ready.file.seconds / 60));
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean();
		assert.deepEqual(campaign.listen, { minutes });

		const email = m.sendingRules.buildRecipientEmail({ campaign, newsletter: user.newsletter, contact });
		const link = `https://${user.slug}.${SHARED_DOMAIN}/p/${user.issue.archiveSlug}#listen`;
		assert.ok(email.html.includes(`Listen to this issue (${minutes} min)`));
		assert.ok(email.html.includes(`<a href="${link}"`), email.html);
		assert.ok(email.text.includes(`Listen to this issue (${minutes} min): ${link}`), email.text.slice(0, 300));
		assert.ok(email.html.indexOf("Listen to this issue") < email.html.indexOf("Sentence number 0"), "above the issue's text");

		const off = await api(user, "PATCH", `/audio-versions/${idOf(user.issue)}`, { emailLink: false });
		assert.equal(off.body.emailLink, false);
		const plain = m.sendingRules.buildRecipientEmail({ campaign: await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean(), newsletter: user.newsletter, contact });
		assert.doesNotMatch(plain.html, /Listen to this issue/);
		assert.doesNotMatch(plain.text, /Listen to this issue/);
		const on = await api(user, "PATCH", `/audio-versions/${idOf(user.issue)}`, { emailLink: true });
		assert.equal(on.body.emailLink, true);
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean()).listen.minutes, minutes);
	});

	test("is not offered for an issue for paid subscribers only, which has no public page, and not before the audio is ready", async () => {
		const user = await publisher();
		const paid = await addIssue(m, user, { subject: "Members", audience: "paid", html: paragraphs(1) });
		await audioFor(user, paid);
		const refused = await api(user, "PATCH", `/audio-versions/${idOf(paid)}`, { emailLink: true });
		assert.equal(refused.status, 400);
		assert.match(refused.body.error.message, /no public page/);
		const missing = await api(user, "PATCH", `/audio-versions/${idOf(user.issue)}`, { emailLink: true });
		assert.equal(missing.status, 404);
		const created = await api(user, "POST", "/audio-versions", { campaign: idOf(user.issue), emailLink: true });
		assert.equal(created.status, 202);
		const pending = await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean();
		assert.equal(pending.listen, undefined, "no link until there is something to listen to");
		await runJobs();
	});
});

describe("the player on the issue's page", () => {
	async function render(user, issue) {
		const element = await m.issuePage({ params: Promise.resolve({ slug: user.slug, post: issue.archiveSlug }) });
		const pitch = { name: user.slug, slug: user.slug, signupFields: [] };
		return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: pitch, readers: 0 }, element));
	}

	test("shows an accessible player for an issue with public audio: play, skip, speeds and a slider, with no script from elsewhere", async () => {
		const user = await publisher();
		const audio = await audioFor(user);
		const html = await render(user, user.issue);
		assert.match(html, /<section id="listen" aria-label="Listen to this issue"/);
		assert.match(html, /aria-label="Play The long weekend"/);
		assert.match(html, /aria-label="Back 15 seconds"/);
		assert.match(html, /aria-label="Forward 15 seconds"/);
		assert.match(html, /<input type="range"[^>]*aria-label="Seek"/);
		assert.match(html, /role="group" aria-label="Playback speed"/);
		for (const speed of ["1x", "1.25x", "1.5x", "2x"]) assert.ok(html.includes(`>${speed}</button>`), speed);
		assert.ok(html.includes(`src="${audio.file.url.replaceAll("&", "&amp;")}"`) || html.includes(audio.file.url));
		assert.match(html, /preload="none"/);
		assert.doesNotMatch(html, /<script[^>]*src=/);
	});

	test("shows none for an issue without audio, and none to anyone for an issue for paid subscribers only until they are known to be paid", async () => {
		const user = await publisher();
		assert.doesNotMatch(await render(user, user.issue), /id="listen"/);
		const paid = await addIssue(m, user, { subject: "Members", audience: "paid", html: paragraphs(1) });
		await audioFor(user, paid);
		assert.doesNotMatch(await render(user, paid), /id="listen"/);
	});

	test("the player remembers the position in this browser and nothing is sent anywhere", async () => {
		const source = await (await import("node:fs/promises")).readFile(new URL("../components/PlayerAudio.jsx", import.meta.url), "utf8");
		assert.match(source, /localStorage/);
		assert.doesNotMatch(source, /fetch\(|sendBeacon|XMLHttpRequest|reportGoal|posthog/i);
		const { formatTime, SPEEDS, SKIP_SECONDS } = await import("../components/PlayerAudio.jsx");
		assert.deepEqual(SPEEDS, [1, 1.25, 1.5, 2]);
		assert.equal(SKIP_SECONDS, 15);
		assert.deepEqual([0, 65, 3725, 59.9].map(formatTime), ["0:00", "1:05", "1:02:05", "0:59"]);
	});
});

describe("the event", () => {
	test("audio.ready reaches an endpoint that takes it, with the example's shape", async () => {
		const user = await publisher();
		const endpoint = await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/flockstack", events: ["audio.ready"] });
		assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
		const audio = await audioFor(user);
		const deliveries = await m.WebhookDelivery.find({ accountId: user.accountId, type: "audio.ready" }).lean();
		assert.equal(deliveries.length, 1);
		const body = JSON.parse(deliveries[0].payload);
		assert.equal(body.type, "audio.ready");
		assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
		const example = m.events.getWebhookEvent("audio.ready").example;
		assert.deepEqual(Object.keys(body.data), Object.keys(example));
		assert.deepEqual(Object.keys(body.data.audio), Object.keys(example.audio));
		assert.deepEqual(
			{ campaignId: body.data.audio.campaignId, subject: body.data.audio.subject, scope: body.data.audio.scope, durationSeconds: body.data.audio.durationSeconds, bytes: body.data.audio.bytes, characters: body.data.audio.characters },
			{ campaignId: idOf(user.issue), subject: "The long weekend", scope: "public", durationSeconds: audio.file.seconds, bytes: audio.file.bytes, characters: audio.characters }
		);
		assert.equal(body.data.audio.issueUrl, `https://${user.slug}.${SHARED_DOMAIN}/p/${user.issue.archiveSlug}`);
		assert.equal(body.data.audio.audioUrl, audio.file.url);
		assert.ok(m.events.WEBHOOK_EVENT_TYPES.includes("audio.ready"));

		const paid = await addIssue(m, user, { subject: "Members", audience: "paid", html: paragraphs(1) });
		await audioFor(user, paid);
		const second = (await m.WebhookDelivery.find({ accountId: user.accountId, type: "audio.ready" }).lean()).map(({ payload }) => JSON.parse(payload).data.audio);
		const paidEvent = second.find(({ subject }) => subject === "Members");
		assert.equal(paidEvent.audioUrl, null, "a paid-only file has no public address to hand out");
		assert.equal(paidEvent.scope, "paid");
	});
});

describe("what's kept, and for how long", () => {
	test("the account's audio files all go with the account", async () => {
		const user = await publisher();
		await audioFor(user);
		const other = await publisher();
		await audioFor(other);
		const mine = (key) => key.startsWith(`accounts/${user.accountId}/audio/`);
		assert.equal([...files.keys()].filter(mine).length, 1);
		memoryObjects.set(`audio/${user.accountId}/leftover/part-0.mp3`, new Uint8Array(3));
		await m.storage.removeAccountAudioFiles(user.accountId);
		assert.equal([...files.keys()].filter(mine).length, 0);
		assert.equal([...memoryObjects.keys()].filter((key) => key.startsWith(`audio/${user.accountId}/`)).length, 0);
		assert.equal([...files.keys()].filter((key) => key.startsWith(`accounts/${other.accountId}/audio/`)).length, 1, "another account's audio stays");
	});

	test("the parts are joined as a stream of known length where the runtime has one", async () => {
		globalThis.FixedLengthStream = class {
			constructor(length) {
				const { readable, writable } = new TransformStream();
				this.readable = readable;
				this.writable = writable;
				this.length = length;
			}
		};
		try {
			const user = await publisher();
			const audio = await audioFor(user);
			const stored = [...files.entries()].find(([key]) => key.startsWith(`accounts/${user.accountId}/audio/`))[1].bytes;
			assert.equal(stored.length, audio.file.bytes);
			assert.equal(stored[0], 1);
			assert.equal(stored.at(-1), 1 + Math.floor(audio.progress.total) - 1);
		} finally {
			delete globalThis.FixedLengthStream;
		}
	});
});

describe("the docs and the API reference", () => {
	test("have an Audio versions page and eight actions", async () => {
		const entry = m.docs.DOC_PAGES.find(({ href }) => href === "/docs/audio");
		assert.equal(entry.title, "Audio versions");
		assert.match(m.docs.getLlmsIndex("https://flockstack.io"), /\[Audio versions\]\(https:\/\/flockstack\.io\/docs\/audio\)/);
		assert.equal(m.docs.getDocsPageMetadata("/docs/audio").alternates.canonical, "/docs/audio");

		const text = renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.docsPage.default())).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
		for (const phrase of ["Audio versions are coming to FlockStack Cloud", "30 days", "Audio version card", "Listen to this issue (12 min)", "/podcast.xml", "never in it", "no overage"]) {
			assert.ok(text.includes(phrase) || text.toLowerCase().includes(phrase.toLowerCase()), phrase);
		}
		for (const plan of m.plans.PLANS) assert.ok(text.includes(m.plans.AUDIO_CHARACTERS_PER_MONTH[plan.id].toLocaleString("en-US")), plan.id);
		assert.doesNotMatch(text, /elevenlabs|cheap/i);

		assert.ok(m.reference.GROUP_DESCRIPTIONS["Audio versions"]);
		const group = m.reference.getEndpointGroups("https://flockstack.io").find(({ group: name }) => name === "Audio versions");
		assert.deepEqual(
			group.endpoints.map(({ name }) => name).sort(),
			["create_audio_version", "delete_audio_version", "get_audio_settings", "get_audio_usage", "get_audio_version", "list_audio_voices", "update_audio_settings", "update_audio_version"]
		);
	});
});
