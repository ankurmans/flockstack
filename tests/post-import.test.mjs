import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryObjects } from "../lib/export-storage.js";
import { countRelativeImages, parseExport, prepareImportedHtml, resolveImportedUrl } from "../lib/post-import-formats.js";
import { describeImportCounts } from "../lib/post-import-report.js";
import { checkPublicUrl } from "../lib/remote-image.js";
import { readZipFiles } from "../lib/unzip.js";
import { activate, anonymous, as, callApi, form, jsonRequest, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";
import { remoteImages, requested } from "./stubs/remote-image.mjs";

const FIXTURES = new URL("./fixtures/post-import/", import.meta.url);
const SHARED_DOMAIN = "flockstackmail.com";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const SUBSTACK_DESK =
	"https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto,q_auto:good/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fdesk.png";
const BEEHIIV_CHART = "https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,quality=80/uploads/asset/file/1a2b/chart.png";
const BEEHIIV_COVER = "https://media.beehiiv.com/cdn-cgi/image/quality=100/uploads/asset/file/1a2b/cover.png";
const GHOST_SITE = "https://ghost.example.com";
let app;
let m;
let processed = 0;

const fixture = (name) => readFileSync(new URL(name, FIXTURES));

// A ZIP as Substack and zip tools write it: deflated files (or stored ones), local headers, then the central directory.
function buildZip(files, { deflate = true } = {}) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const [name, content] of files) {
		const bytes = Buffer.from(content);
		const data = deflate ? zlib.deflateRawSync(bytes) : bytes;
		const nameBytes = Buffer.from(name);
		const crc = zlib.crc32(bytes);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(bytes.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(deflate ? 8 : 0, 10);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(bytes.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		central.push(entry, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

function substackZip(options) {
	const posts = readdirSync(new URL("substack/posts/", FIXTURES)).map((name) => [`posts/${name}`, fixture(`substack/posts/${name}`)]);
	return buildZip([["posts.csv", fixture("substack/posts.csv")], ...posts], options);
}

async function runJobs() {
	const results = [];
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (!url.endsWith("/api/jobs/import-posts")) continue;
		const response = await m.jobRoute.POST(jsonRequest(url, { method: "POST", body }));
		results.push({ status: response.status, ...(await response.json()) });
	}
	return results;
}

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	user.newsletter = await m.Newsletter.create({
		accountId: user.accountId,
		name: `${slug} notes`,
		slug,
		fromName: "Jane Doe",
		fromEmail: `hello@${slug}.${SHARED_DOMAIN}`,
		archiveEnabled: true,
	});
	return user;
}

async function importFile(user, bytes, body = {}) {
	const created = await callApi("POST", "/api/v1/post-imports", { key: user.key, body: { newsletter: user.newsletter.slug, base64: Buffer.from(bytes).toString("base64"), ...body } });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	return created.body;
}

async function startAndRun(user, id, { before: beforeRun } = {}) {
	const started = await callApi("POST", `/api/v1/post-imports/${id}/start`, { key: user.key });
	assert.equal(started.status, 202, JSON.stringify(started.body));
	await beforeRun?.();
	const results = await runJobs();
	const latest = await callApi("GET", `/api/v1/post-imports/${id}`, { key: user.key });
	return { started: started.body, results, report: latest.body };
}

function visitHost(slug, path) {
	m.clearRedirectCache();
	const url = `https://${slug}.${SHARED_DOMAIN}${path}`;
	return m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
}

function issuesOf(user) {
	return m.Campaign.find({ accountId: user.accountId, newsletterId: user.newsletter._id }).sort({ sentAt: -1 }).lean();
}

before(async () => {
	app = await startTestApp({ EXPORT_STORAGE: "memory", IMPORT_STEP_MS: "0", QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		jobRoute: await import("../app/api/jobs/import-posts/route.js"),
		uploadRoute: await import("../app/api/post-imports/route.js"),
		importPage: await import("../app/(app)/newsletters/import/page.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		postImport: await import("../lib/post-import.js"),
		runAction: (await import("../lib/actions/run-action.js")).runAction,
		author: await import("../lib/archive-author.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		clearRedirectCache: (await import("../lib/redirect-routing.js")).clearRedirectCache,
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		PostImport: (await import("../models/PostImport.js")).default,
		Redirect: (await import("../models/Redirect.js")).default,
		Upload: (await import("../models/Upload.js")).default,
	};
});

after(() => app?.stop());

describe("reading exports", () => {
	test("Substack's ZIP: published newsletter posts with their HTML file, newest first; drafts, podcasts and posts without a file are counted", async () => {
		for (const options of [{ deflate: true }, { deflate: false }]) {
			const { source, posts, skipped } = await parseExport(substackZip(options));
			assert.equal(source, "substack");
			assert.deepEqual(skipped, { drafts: 1, other: 1, missingContent: 1 });
			assert.deepEqual(
				posts.map(({ sourceId, title, slug, oldPath, paid, publishedAt }) => ({ sourceId, title, slug, oldPath, paid, publishedAt })),
				[
					{ sourceId: "140000002", title: "The paid deep dive", slug: "the-paid-deep-dive", oldPath: "/p/the-paid-deep-dive", paid: true, publishedAt: "2024-04-10T09:30:00.000Z" },
					{ sourceId: "140000001", title: "Why we moved", slug: "why-we-moved", oldPath: "/p/why-we-moved", paid: false, publishedAt: "2024-03-05T14:00:00.000Z" },
				]
			);
			assert.equal(posts[1].subtitle, "And what changes for you & the list");
			assert.match(posts[1].html, /captioned-image-container/);
		}
	});

	test("beehiiv's posts CSV: confirmed posts, premium ones paid, the cover on beehiiv's CDN, dates in UTC", async () => {
		const { source, posts, skipped } = await parseExport(fixture("beehiiv-posts.csv"));
		assert.equal(source, "beehiiv");
		assert.deepEqual(skipped, { drafts: 1, other: 0, missingContent: 0 });
		assert.deepEqual(
			posts.map(({ title, subtitle, oldPath, paid, publishedAt, thumbnailUrl }) => ({ title, subtitle, oldPath, paid, publishedAt, thumbnailUrl })),
			[
				{ title: "Members only: the playbook", subtitle: "The full playbook", oldPath: "/p/members-only-playbook", paid: true, publishedAt: "2025-07-14T07:00:00.000Z", thumbnailUrl: null },
				{ title: "Our first week", subtitle: "What we learned in seven days", oldPath: "/p/our-first-week", paid: false, publishedAt: "2025-06-02T15:30:00.000Z", thumbnailUrl: BEEHIIV_COVER },
			]
		);
	});

	test("WordPress's WXR: published posts with their permalink, author's display name and featured image; pages and drafts left out", async () => {
		const { source, posts, skipped, siteUrl } = await parseExport(fixture("wordpress.xml"));
		assert.equal(source, "wordpress");
		assert.equal(siteUrl, "https://blog.example.com");
		assert.deepEqual(skipped, { drafts: 1, other: 1, missingContent: 0 });
		assert.deepEqual(
			posts.map(({ sourceId, title, oldPath, author, thumbnailUrl }) => ({ sourceId, title, oldPath, author, thumbnailUrl })),
			[
				{ sourceId: "57", title: "A block editor post", oldPath: "/2024/01/09/block-editor-post/", author: "Sam Guest", thumbnailUrl: null },
				{ sourceId: "42", title: "Hello world & welcome", oldPath: "/2023/05/12/hello-world/", author: "Jane Doe", thumbnailUrl: "https://blog.example.com/wp-content/uploads/2023/05/cover.jpg" },
			]
		);
		// The classic editor's blank lines are paragraphs, and its [caption] shortcode goes.
		assert.match(posts[1].html, /^<p>Welcome to the blog\. This is the first post\.<\/p>/);
		assert.doesNotMatch(posts[1].html, /\[caption/);
	});

	test("Ghost's JSON: published posts, paid visibility, the first author, /slug/ addresses", async () => {
		const { source, posts, skipped } = await parseExport(fixture("ghost.json"));
		assert.equal(source, "ghost");
		assert.deepEqual(skipped, { drafts: 1, other: 1, missingContent: 0 });
		assert.deepEqual(
			posts.map(({ title, oldPath, author, paid }) => ({ title, oldPath, author, paid })),
			[
				{ title: "Members: the full teardown", oldPath: "/full-teardown/", author: "Jane Doe", paid: true },
				{ title: "Notes on a slow web", oldPath: "/notes-on-a-slow-web/", author: "Riley Guest", paid: false },
			]
		);
		assert.equal(resolveImportedUrl(posts[1].thumbnailUrl, GHOST_SITE), `${GHOST_SITE}/content/images/2024/06/cover.png`);
		assert.equal(resolveImportedUrl(posts[1].thumbnailUrl, null), null);
	});

	test("a ZIP around one export is read as that export; anything else is refused with what to upload", async () => {
		const zipped = await parseExport(buildZip([["export/wordpress.xml", fixture("wordpress.xml")]]));
		assert.equal(zipped.source, "wordpress");
		assert.equal(zipped.posts.length, 2);

		await assert.rejects(parseExport(Buffer.from("name,email\nJane,jane@example.com\n")), { code: "validation_failed", message: /can't tell which platform/ });
		await assert.rejects(parseExport(fixture("substack/posts.csv")), /whole export ZIP/);
		await assert.rejects(parseExport(fixture("ghost.json"), { expected: "substack" }), /looks like a Ghost export, not Substack/);
		await assert.rejects(parseExport(Buffer.from("{ not json")), /can't be read/);
		await assert.rejects(parseExport(buildZip([["a.csv", "x"], ["b.json", "{}"]])), /no posts\.csv/);
		await assert.rejects(parseExport(Buffer.from("<?xml version=\"1.0\"?><rss><channel></channel></rss>")), /isn't a WordPress export/);
	});

	test("a ZIP that expands past the limit stops before it is read whole", async () => {
		const bomb = buildZip([["posts.csv", Buffer.alloc(2_000_000, 0x61)]]);
		assert.ok(bomb.length < 10_000);
		await assert.rejects(readZipFiles(bomb, { maxBytes: 1_000_000 }), /expands to more/);
		assert.equal((await readZipFiles(bomb, { maxBytes: 3_000_000 })).get("posts.csv").length, 2_000_000);
	});

	test("the old platform's HTML loses its placeholders, layout tables and Ghost's site marker", () => {
		const beehiiv = prepareImportedHtml('<table><tr id="content-blocks"><td><p>Hi {{subscriber_first_name}}, <a href="{{rp_refer_url}}">share</a></p></td></tr></table>', { source: "beehiiv" });
		assert.doesNotMatch(beehiiv, /<t(able|r|d)\b|\{\{/);
		assert.match(beehiiv, /Hi there, <a href="#">share<\/a>/);
		const ghost = prepareImportedHtml('<img src="__GHOST_URL__/content/images/a.png"><figcaption>Caption</figcaption><a href="/older/">x</a>', { source: "ghost", siteUrl: GHOST_SITE });
		assert.equal(ghost, `<img src="${GHOST_SITE}/content/images/a.png"><p><small>Caption</small></p><a href="${GHOST_SITE}/older/">x</a>`);
		assert.equal(countRelativeImages(prepareImportedHtml('<img src="__GHOST_URL__/a.png"><img src="https://example.com/b.png">', { source: "ghost" })), 1);
	});
});

test("pictures and exports are only fetched from public https hosts", () => {
	for (const link of ["https://substackcdn.com/image/fetch/a.png", "https://93.184.216.34/a.png"]) assert.equal(checkPublicUrl(link).protocol, "https:", link);
	for (const link of [
		"http://example.com/a.png",
		"https://localhost/a.png",
		"https://admin.localhost/a.png",
		"https://intranet/a.png",
		"https://127.0.0.1/a.png",
		"https://10.0.0.8/a.png",
		"https://169.254.169.254/latest/meta-data/",
		"https://[::1]/a.png",
		"https://[fd00::1]/a.png",
		"https://user:pass@example.com/a.png",
		"https://example.com:8443/a.png",
		"file:///etc/passwd",
		"not a url",
	]) {
		assert.throws(() => checkPublicUrl(link), { code: "validation_failed" }, link);
	}
});

describe("importing posts", () => {
	let jane;

	before(async () => {
		jane = await customer("jane-import@example.com", "field-notes");
		// Another account's issue has the slug first: Jane's post gets the next one, and a redirect from the old address.
		const other = await signIn("other-import@example.com");
		await m.Campaign.create({ accountId: other.accountId, newsletterId: jane.newsletter._id, subject: "Taken", status: "sent", archiveSlug: "why-we-moved", sentAt: new Date() });
		remoteImages.set(SUBSTACK_DESK, PNG);
	});

	test("an upload is read and previewed; nothing is imported until it starts", async () => {
		const preview = await importFile(jane, substackZip());
		assert.equal(preview.status, "ready");
		assert.equal(preview.source, "substack");
		assert.deepEqual(preview.preview.titles, ["The paid deep dive", "Why we moved"]);
		assert.equal(preview.preview.posts, 2);
		assert.equal(preview.preview.paid, 1);
		assert.deepEqual(preview.preview.skipped, { drafts: 1, other: 1, missingContent: 1 });
		assert.equal(preview.limits, null);
		assert.equal((await issuesOf(jane)).length, 0);
		jane.firstImport = preview.id;
	});

	test("starting it turns each post into a sent issue on its date, with no email and no usage, pictures copied and a redirect where the address changed", async () => {
		const sentBefore = (await m.Account.findById(jane.accountId).lean()).usage?.emailsSent ?? 0;
		const { started, results, report } = await startAndRun(jane, jane.firstImport);
		assert.equal(started.started, true);
		assert.deepEqual(started.limits, { posts: 500, imageBytes: 1024 ** 3 });
		assert.ok(results.length >= 3, "one post a step, then the next job");
		assert.ok(results.every(({ status }) => status === 200));
		assert.equal(report.status, "done");
		assert.deepEqual(report.progress, { done: 2, total: 2 });
		assert.deepEqual(report.counts, { imported: 2, existing: 0, overLimit: 0, failed: 0, images: 1, imageFailures: 1, imageBytes: PNG.length, redirects: 1 });

		const [paid, moved] = await issuesOf(jane);
		assert.equal(moved.subject, "Why we moved");
		assert.equal(moved.previewText, "And what changes for you & the list");
		assert.equal(moved.status, "sent");
		assert.equal(moved.source, "import");
		assert.equal(moved.audience, "all");
		assert.equal(moved.importKey, "substack:140000001");
		assert.deepEqual(moved.sentAt, new Date("2024-03-05T14:00:00.000Z"));
		assert.equal(moved.archiveSlug, "why-we-moved-2");
		assert.equal(moved.stats.sent, 0);
		assert.doesNotMatch(moved.html, /<form|<input|<script|<img src="https:\/\/substackcdn\.com[^"]*desk/);
		assert.match(moved.html, /<p><small>Where the next issues get written\.<\/small><\/p>/);
		assert.match(moved.html, /src="https:\/\/blob\.example\.com\/accounts\/[^"]+\/images\/desk-1\.png"/);
		assert.match(moved.html, /src="https:\/\/substackcdn\.com\/image\/fetch\/w_1456\/https%3A%2F%2Fexample\.org%2Fgone\.png"/, "a picture that can't be copied keeps its link");
		assert.equal(moved.thumbnailUrl, (await m.Upload.findOne({ accountId: jane.accountId, sourceUrl: SUBSTACK_DESK }).lean()).url);
		assert.equal(paid.audience, "paid");
		assert.doesNotMatch(paid.html, /alert/);

		assert.equal(await m.Message.countDocuments({ accountId: jane.accountId }), 0);
		assert.equal((await m.Account.findById(jane.accountId).lean()).usage?.emailsSent ?? 0, sentBefore);
		const redirect = await m.Redirect.findOne({ accountId: jane.accountId, path: "/p/why-we-moved" }).lean();
		assert.equal(redirect.to, "/p/why-we-moved-2");
		assert.equal(redirect.source, "import");
		assert.equal(await m.Redirect.countDocuments({ accountId: jane.accountId, path: "/p/the-paid-deep-dive" }), 0, "an unchanged address needs none");

		const email = platformEmails.findLast(({ subject }) => subject === "Your Substack archive is in field-notes notes");
		assert.match(email.text, /2 posts imported, 1 picture copied, 1 picture left at the old address, 1 redirect added/);
		assert.ok(![...memoryObjects.keys()].some((key) => key.startsWith(`imports/${jane.accountId}/${jane.firstImport}/`)), "a finished import's files go");
	});

	test("the same export imported again adds nothing and fetches nothing", async () => {
		const fetched = requested.length;
		const again = await importFile(jane, substackZip());
		const { report } = await startAndRun(jane, again.id);
		assert.equal(report.status, "done");
		assert.equal(report.counts.imported, 0);
		assert.equal(report.counts.existing, 2);
		assert.equal(report.counts.redirects, 0);
		assert.equal((await issuesOf(jane)).length, 2);
		assert.equal(requested.length, fetched);
		assert.equal(await m.Redirect.countDocuments({ accountId: jane.accountId }), 1);
	});

	test("old addresses answer 301 on the newsletter's website, with their query; other paths answer as before", async () => {
		const moved = await visitHost("field-notes", "/p/why-we-moved/?utm_source=twitter");
		assert.equal(moved.status, 301);
		assert.equal(moved.headers.get("location"), `https://field-notes.${SHARED_DOMAIN}/p/why-we-moved-2?utm_source=twitter`);
		const issue = await visitHost("field-notes", "/p/why-we-moved-2");
		assert.equal(issue.status, 200);
		assert.match(issue.headers.get("x-middleware-rewrite"), /\/archive\/field-notes\/p\/why-we-moved-2$/);
		assert.equal((await visitHost("field-notes", "/nothing-here")).status, 404);
		assert.equal((await visitHost("field-notes", "/feed.xml")).status, 200);
	});

	test("past the plan's cap posts are left out, newest first, and pictures stop at the bytes the plan allows; importing again brings the rest", async () => {
		const sam = await customer("sam-import@example.com", "grow-notes");
		remoteImages.set(BEEHIIV_CHART, PNG);
		remoteImages.set(BEEHIIV_COVER, PNG);
		const first = await importFile(sam, fixture("beehiiv-posts.csv"), { source: "beehiiv" });
		const { report } = await startAndRun(sam, first.id, {
			before: () => m.PostImport.updateOne({ accountId: sam.accountId, _id: first.id }, { $set: { "limits.posts": 1 } }),
		});
		assert.equal(report.counts.imported, 1);
		assert.equal(report.counts.overLimit, 1);
		assert.deepEqual((await issuesOf(sam)).map(({ subject }) => subject), ["Members only: the playbook"]);

		const second = await importFile(sam, fixture("beehiiv-posts.csv"));
		const rest = await startAndRun(sam, second.id, {
			before: () => m.PostImport.updateOne({ accountId: sam.accountId, _id: second.id }, { $set: { "limits.imageBytes": PNG.length } }),
		});
		assert.deepEqual(rest.report.counts, { imported: 1, existing: 1, overLimit: 0, failed: 0, images: 1, imageFailures: 1, imageBytes: PNG.length, redirects: 0 });
		const [, week] = await issuesOf(sam);
		assert.equal(week.subject, "Our first week");
		assert.match(week.html, /Hello there, thanks for being here\./);
		assert.doesNotMatch(week.html, /<table|\{\{/);
		assert.equal(describeImportCounts(rest.report.counts), "1 post imported, 1 already there, 1 picture copied, 1 picture left at the old address");
	});

	test("the dashboard uploads the file as it is; Ghost's pictures come from the old address, and a guest author keeps their name", async () => {
		const riley = await customer("riley-import@example.com", "slow-web");
		const post = (headers, body = fixture("ghost.json")) =>
			m.uploadRoute.POST(new Request("http://localhost:3000/api/post-imports", { method: "POST", headers, body }));
		assert.equal((await as(riley, () => post({ "sec-fetch-site": "cross-site" }))).status, 403);
		assert.equal((await anonymous(() => post({}))).status, 401);

		remoteImages.set(`${GHOST_SITE}/content/images/2024/06/modem.png`, PNG);
		remoteImages.set(`${GHOST_SITE}/content/images/2024/06/cover.png`, Buffer.concat([PNG, Buffer.from("cover")]));
		const response = await as(riley, () => post({ "x-newsletter": "slow-web", "x-file-name": encodeURIComponent("ghost export.json"), "x-site-url": encodeURIComponent(GHOST_SITE) }));
		assert.equal(response.status, 200);
		const { import: created } = await response.json();
		assert.equal(created.fileName, "ghost export.json");
		assert.equal(created.siteUrl, GHOST_SITE);

		const page = renderToStaticMarkup(createElement(m.TooltipProvider, null, await as(riley, () => m.importPage.default())));
		assert.match(page, /Import 2 posts/);
		assert.match(page, /Notes on a slow web/);

		const { report } = await startAndRun(riley, created.id);
		assert.equal(report.counts.imported, 2);
		assert.equal(report.counts.images, 2);
		const slow = (await issuesOf(riley)).find(({ subject }) => subject === "Notes on a slow web");
		assert.equal(slow.importedFrom.author, "Riley Guest");
		assert.equal(slow.importedFrom.url, `${GHOST_SITE}/notes-on-a-slow-web/`);
		assert.match(slow.thumbnailUrl, /^https:\/\/blob\.example\.com\/.*cover/);
		const newsletter = await m.Newsletter.findOne({ accountId: riley.accountId, _id: riley.newsletter._id }).lean();
		assert.deepEqual(m.author.getIssueAuthor({ ...newsletter, fromName: "Jane Doe" }, slow), { name: "Riley Guest", slug: null, bio: "", imageUrl: "" });
		assert.equal(m.author.getIssueAuthor({ ...newsletter, fromName: "Riley Guest" }, slow).slug, "riley-guest");
		assert.equal((await m.Redirect.findOne({ accountId: riley.accountId, path: "/notes-on-a-slow-web" }).lean()).to, "/p/notes-on-a-slow-web");
	});

	test("an account without a plan can't import, and one import runs at a time", async () => {
		const noPlan = await signIn("noplan-import@example.com");
		await assert.rejects(
			m.runAction("create_post_import", { account: noPlan.account, via: "api", input: { base64: Buffer.from("x").toString("base64") } }),
			{ code: "subscription_required" }
		);

		const first = await importFile(jane, fixture("wordpress.xml"));
		const second = await importFile(jane, fixture("ghost.json"));
		assert.equal((await callApi("POST", `/api/v1/post-imports/${first.id}/start`, { key: jane.key })).status, 202);
		const again = await callApi("POST", `/api/v1/post-imports/${first.id}/start`, { key: jane.key });
		assert.equal(again.body.started, false);
		const blocked = await callApi("POST", `/api/v1/post-imports/${second.id}/start`, { key: jane.key });
		assert.equal(blocked.status, 409);
		await runJobs();
		const wordpress = await callApi("GET", `/api/v1/post-imports/${first.id}`, { key: jane.key });
		assert.equal(wordpress.body.counts.redirects, 2);
		assert.equal((await visitHost("field-notes", "/2023/05/12/hello-world/")).headers.get("location"), `https://field-notes.${SHARED_DOMAIN}/p/hello-world`);
		const list = await callApi("GET", "/api/v1/post-imports?newsletter=field-notes", { key: jane.key });
		assert.equal(list.body.imports[0].id, second.id);
	});

	test("an account's purge removes the files of its imports", async () => {
		const pending = await importFile(jane, fixture("ghost.json"));
		const prefix = `imports/${jane.accountId}/${pending.id}/`;
		assert.ok([...memoryObjects.keys()].some((key) => key.startsWith(prefix)));
		await m.postImport.removeAccountImportFiles({ _id: jane.accountId });
		assert.ok(![...memoryObjects.keys()].some((key) => key.startsWith(`imports/${jane.accountId}/`)));
	});
});
