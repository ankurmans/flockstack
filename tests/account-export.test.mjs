import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import zlib from "node:zlib";
import { createAccountExportToken } from "../lib/account-export-token.js";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";
import { createZipStream, crc32, getZipSize, readStream, splitIntoVolumes } from "../lib/zip.js";
import { activate, as, callApi, form, jsonRequest, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { readResponseBytes, readZip } from "./helpers/zip.mjs";
import { memoryObjects } from "../lib/export-storage.js";
import { published } from "./stubs/qstash.mjs";

const IMAGE_HOST = "https://img.example.com";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
let app;
let m;
let processed = 0;
const fetched = [];
let realFetch;

async function runJobs() {
	const results = [];
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (!url.endsWith("/api/jobs/export-account")) continue;
		const response = await m.jobRoute.POST(jsonRequest(url, { method: "POST", body }));
		results.push({ status: response.status, ...(await response.json()) });
	}
	return results;
}

async function customer(email, { slug } = {}) {
	const user = await signIn(email);
	await activate(user);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	const name = slug ?? email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	user.newsletter = await m.Newsletter.create({
		accountId: user.accountId,
		name: `${name} notes`,
		slug: name,
		fromName: "Jane Doe",
		fromEmail: `hello@${name}.flockstackmail.com`,
		archiveEnabled: true,
		description: "One idea a week",
	});
	return user;
}

function addContacts(user, rows, newsletterId = user.newsletter._id) {
	return m.Contact.insertMany(rows.map((row) => ({ accountId: user.accountId, newsletterId, ...row })));
}

function addIssue(user, fields) {
	return m.Campaign.create({
		accountId: user.accountId,
		newsletterId: user.newsletter._id,
		status: "sent",
		format: "rich",
		sentAt: new Date("2026-10-01T08:00:00Z"),
		startedAt: new Date("2026-10-01T08:00:00Z"),
		...fields,
	});
}

async function exportAndWait(user) {
	const started = await callApi("POST", "/api/v1/account/export", { key: user.key });
	assert.equal(started.status, 202, JSON.stringify(started.body));
	const results = await runJobs();
	const latest = await callApi("GET", "/api/v1/account/export", { key: user.key });
	return { started, results, latest };
}

async function download(url) {
	const link = new URL(url);
	return m.zipRoute.GET(new Request(link));
}

function isValidZip(bytes) {
	const folder = mkdtempSync(join(tmpdir(), "export-"));
	try {
		const file = join(folder, "export.zip");
		writeFileSync(file, bytes);
		const result = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
		if (result.error) return null;
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return true;
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

before(async () => {
	app = await startTestApp({ EXPORT_STORAGE: "memory", QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input?.url ?? input);
		if (!url.startsWith(`${IMAGE_HOST}/`)) return realFetch(input, init);
		fetched.push(url);
		if (url.includes("gone")) return new Response("missing", { status: 404 });
		return new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
	};
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		accountPage: await import("../app/(account)/account/page.js"),
		exportActions: await import("../app/(account)/account/export/actions.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		jobRoute: await import("../app/api/jobs/export-account/route.js"),
		zipRoute: await import("../app/api/v1/account/export.zip/route.js"),
		blocks: await import("../lib/account-blocks.js"),
		exports: await import("../lib/account-export.js"),
		runAction: (await import("../lib/actions/run-action.js")).runAction,
		Account: (await import("../models/Account.js")).default,
		AccountExport: (await import("../models/AccountExport.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		ExportFile: (await import("../models/ExportFile.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
		Upload: (await import("../models/Upload.js")).default,
	};
});

after(() => {
	globalThis.fetch = realFetch;
	return app?.stop();
});

describe("the ZIP writer", () => {
	test("streams stored files with correct sizes and checksums, and says its size beforehand", async () => {
		const parts = new Map([
			["a.txt", [Buffer.from("hello "), Buffer.from("world")]],
			["folder/ünï.txt", [Buffer.from("tëxt")]],
			["empty.txt", []],
		]);
		const files = [...parts].map(([path, chunks]) => {
			const bytes = Buffer.concat(chunks);
			return { path, size: bytes.length, crc: crc32(bytes), chunks };
		});
		assert.equal(crc32(Buffer.from("hello world")), zlib.crc32(Buffer.from("hello world")));
		assert.equal(crc32(Buffer.from("world"), crc32(Buffer.from("hello "))), zlib.crc32(Buffer.from("hello world")), "a CRC chains over chunks");

		const bytes = Buffer.concat(await Array.fromAsync(readStream(createZipStream({ files, read: async function* (file) { yield* file.chunks; } }))));
		assert.equal(bytes.length, getZipSize(files));
		const read = readZip(bytes);
		assert.deepEqual([...read.keys()], ["a.txt", "folder/ünï.txt", "empty.txt"]);
		assert.equal(read.get("a.txt").toString(), "hello world");
		assert.equal(read.get("folder/ünï.txt").toString(), "tëxt");
		assert.equal(read.get("empty.txt").length, 0);
		isValidZip(bytes);
	});

	test("refuses a file whose bytes don't match its size", async () => {
		const stream = createZipStream({ files: [{ path: "a.txt", size: 10, crc: 0 }], read: async function* () { yield Buffer.from("short"); } });
		await assert.rejects(Array.fromAsync(readStream(stream)), /short of its size/);
	});

	test("splits a large export into ZIPs that each fit", () => {
		const files = Array.from({ length: 7 }, (_, index) => ({ path: `f${index}.bin`, size: 400 }));
		const volumes = splitIntoVolumes(files, { maxBytes: 1200, maxFiles: 100 });
		assert.deepEqual(volumes.map((volume) => volume.length), [2, 2, 2, 1]);
		assert.deepEqual(splitIntoVolumes(files, { maxBytes: 1e9, maxFiles: 3 }).map((volume) => volume.length), [3, 3, 1]);
		assert.deepEqual(splitIntoVolumes([{ path: "huge.bin", size: 5000 }], { maxBytes: 1000 }), [[{ path: "huge.bin", size: 5000 }]], "a file bigger than a ZIP still gets one");
	});
});

describe("Markdown from issues", () => {
	test("keeps the editor's formatting", () => {
		const markdown = htmlToMarkdown(
			'<h2>Big news</h2><p>Read <a href="https://example.com/x?a=1&amp;b=2">this</a>, <strong>now</strong> and <em>later</em> with <code>code</code> &amp; snake_case.</p><ul><li><p>One</p></li><li>Two<ul><li>Nested</li></ul></li></ul><ol start="3"><li>Third</li></ol><blockquote><p>Quoted</p></blockquote><p><img src="https://img.example.com/a.png" alt="A cat"></p><hr><pre><code>let x = 1;\nlet y = 2;</code></pre>'
		);
		assert.equal(
			markdown,
			"## Big news\n\nRead [this](https://example.com/x?a=1&b=2), **now** and *later* with `code` & snake\\_case.\n\n- One\n- Two\n  - Nested\n\n3. Third\n\n> Quoted\n\n![A cat](https://img.example.com/a.png)\n\n---\n\n```\nlet x = 1;\nlet y = 2;\n```\n"
		);
	});
});

describe("an export", () => {
	test("holds the contacts, issues, pictures, suppression list and a manifest, and arrives by email", async () => {
		const user = await customer("export-owner@example.com", { slug: "field-notes" });
		const second = await m.Newsletter.create({ accountId: user.accountId, name: "Second", slug: "second", fromEmail: "hello@second.flockstackmail.com" });
		await addContacts(user, [
			{ email: "ann@example.org", status: "active", source: "website", subscribedAt: new Date("2026-01-02T10:00:00Z"), confirmedAt: new Date("2026-01-02T10:05:00Z"), stats: { sent: 4, opens: 3, clicks: 1 }, lastOpenAt: new Date("2026-09-01T00:00:00Z") },
			{ email: "bob@example.org", status: "unsubscribed", source: "api", unsubscribedAt: new Date("2026-03-03T00:00:00Z") },
			{ email: "=SUM(1;1)@example.org", status: "pending" },
		]);
		await addContacts(user, [{ email: "cat@example.org", status: "active" }], second._id);
		await m.Suppression.create({ accountId: user.accountId, email: "gone@example.org", reason: "bounce", detail: "550 no such user" });

		const mine = await m.Upload.create({ accountId: user.accountId, url: `${IMAGE_HOST}/accounts/a/cover-1111.png`, pathname: "accounts/a/cover-1111.png", contentType: "image/png", bytes: PNG.length });
		await m.Upload.create({ accountId: user.accountId, url: `${IMAGE_HOST}/accounts/a/gone-2222.png`, pathname: "accounts/a/gone-2222.png", contentType: "image/png", bytes: 10 });
		const other = await customer("export-other@example.com", { slug: "other-notes" });
		await m.Upload.create({ accountId: other.accountId, url: `${IMAGE_HOST}/accounts/b/theirs-3333.png`, pathname: "accounts/b/theirs-3333.png", contentType: "image/png", bytes: 10 });

		const rich = await addIssue(user, {
			subject: 'Pricing: "charge" more & <better>',
			previewText: "Charge more than feels right.",
			archiveSlug: "pricing-issue",
			html: `<h2>Hello</h2><p>Look <strong>here</strong></p><p><img src="${mine.url}" alt="cover"></p><p><img src="${IMAGE_HOST}/accounts/a/gone-2222.png" alt="lost"></p><p><img src="${IMAGE_HOST}/accounts/b/theirs-3333.png" alt="not mine"></p>`,
		});
		await addIssue(user, { subject: "Markdown one", archiveSlug: "markdown-one", format: "markdown", markdown: `# Title\n\nSome **bold** text ![cover](${mine.url})`, sentAt: new Date("2026-10-08T08:00:00Z") });
		await addIssue(user, { subject: "Designed", archiveSlug: "designed", format: "html", html: "<!doctype html><html><head><title>x</title></head><body><h1>Designed issue</h1><p>Body</p></body></html>" });
		await addIssue(user, { subject: "Unfinished draft", status: "draft", html: "<p>Still writing</p>", sentAt: undefined, startedAt: undefined });

		const { started, results, latest } = await exportAndWait(user);
		assert.equal(started.body.status, "queued");
		assert.equal(started.body.started, true);
		assert.deepEqual(started.body.downloadUrls, []);
		assert.ok(results.some((result) => result.ready), JSON.stringify(results));
		assert.equal(latest.body.status, "ready");
		assert.equal(latest.body.downloadUrls.length, 1);
		assert.deepEqual(
			{ ...latest.body.counts, bytes: undefined },
			{ newsletters: 2, contacts: 4, campaigns: 4, images: 1, missingImages: 1, bytes: undefined }
		);
		assert.deepEqual(fetched.filter((url) => url.includes("theirs")), [], "another account's upload is never fetched");

		const response = await download(latest.body.downloadUrls[0]);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/zip");
		assert.match(response.headers.get("content-disposition"), /^attachment; filename="flockstack-export-\d{4}-\d{2}-\d{2}\.zip"$/);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const bytes = await readResponseBytes(response);
		assert.equal(Number(response.headers.get("content-length")), bytes.length);
		isValidZip(bytes);
		const zip = readZip(bytes);
		const text = (path) => zip.get(path)?.toString("utf8");
		const paths = [...zip.keys()];
		assert.deepEqual(paths.slice(0, 2), ["README.txt", "manifest.json"], "the manifest and README come first");

		const csv = text("contacts/field-notes.csv");
		const [header, ...rows] = csv.trim().split("\r\n");
		assert.equal(header, "email,status,newsletter,source,subscribed_at,confirmed_at,unsubscribed_at,last_sent_at,last_open_at,last_click_at,emails_received,opens,clicks,tags,referrals,referred_by,created_at");
		assert.equal(rows.length, 3);
		const ann = rows.find((row) => row.startsWith("ann@example.org"));
		assert.match(ann, /^ann@example\.org,active,field-notes,website,2026-01-02T10:00:00\.000Z,2026-01-02T10:05:00\.000Z,,,2026-09-01T00:00:00\.000Z,,4,3,1,,0,,/);
		assert.ok(rows.some((row) => row.startsWith("'=sum(1;1)@example.org,pending")), "an address that starts like a formula is quoted");
		assert.equal(text("contacts/second.csv").trim().split("\r\n").length, 2);
		assert.match(text("suppressions.csv"), /gone@example\.org,bounce,550 no such user,/);

		const imagePaths = paths.filter((path) => path.startsWith("images/"));
		assert.deepEqual(imagePaths, ["images/cover-1111.png"], "only the picture that could be fetched, and only the account's own");
		assert.deepEqual([...zip.get("images/cover-1111.png")], [...PNG]);

		const richMd = text("campaigns/field-notes/2026-10-01-pricing-issue.md");
		assert.match(richMd, /^---\ntitle: "Pricing: \\"charge\\" more & <better>"\ndate: 2026-10-01T08:00:00\.000Z\nnewsletter: "field-notes"\nstatus: "sent"\narchive_url: "https:\/\/field-notes\.flockstackmail\.com\/p\/pricing-issue"\npreview_text: "Charge more than feels right\."\nslug: "pricing-issue"\nformat: "rich"\nid: "[0-9a-f]{24}"\n---\n/);
		assert.match(richMd, /## Hello\n\nLook \*\*here\*\*/);
		assert.match(richMd, /!\[cover\]\(\.\.\/\.\.\/images\/cover-1111\.png\)/, "the uploaded picture points to the file in the ZIP");
		assert.match(richMd, /!\[lost\]\(\.\.\/\.\.\/images\/gone-2222\.png\)/, "a picture that couldn't be fetched still points to its place, and the manifest has its address");
		assert.match(richMd, /!\[not mine\]\(https:\/\/img\.example\.com\/accounts\/b\/theirs-3333\.png\)/, "another account's picture is left as it was");
		const richHtml = text("campaigns/field-notes/2026-10-01-pricing-issue.html");
		assert.ok(richHtml.startsWith("---\ntitle:"), "the HTML carries the same frontmatter");
		assert.match(richHtml, /<html/);
		assert.match(richHtml, /src="\.\.\/\.\.\/images\/cover-1111\.png"/);
		assert.match(text("campaigns/field-notes/2026-10-08-markdown-one.md"), /\n# Title\n\nSome \*\*bold\*\* text !\[cover\]\(\.\.\/\.\.\/images\/cover-1111\.png\)\n$/);
		assert.match(text("campaigns/field-notes/2026-10-01-designed.md"), /# Designed issue\n\nBody\n$/);
		const draftPath = paths.find((path) => path.includes("unfinished-draft"));
		assert.match(draftPath, /^campaigns\/field-notes\/undated-unfinished-draft-[0-9a-f]{6}\.md$|^campaigns\/field-notes\/.*unfinished-draft-[0-9a-f]{6}\.(md|html)$/);
		assert.match(text(draftPath.replace(/\.html$/, ".md")), /status: "draft"/);

		const manifest = JSON.parse(text("manifest.json"));
		assert.equal(manifest.format, "flockstack-export");
		assert.equal(manifest.version, 1);
		assert.deepEqual(manifest.counts, { newsletters: 2, contacts: 4, campaigns: 4, images: 1, missingImages: 1 });
		assert.deepEqual(manifest.newsletters.map(({ slug, contactCount, contactsFile }) => [slug, contactCount, contactsFile]), [["field-notes", 3, "contacts/field-notes.csv"], ["second", 1, "contacts/second.csv"]]);
		assert.equal(manifest.newsletters[0].welcome.enabled, false);
		assert.equal(manifest.newsletters[0].archiveUrl, "https://field-notes.flockstackmail.com/");
		assert.equal(manifest.campaigns.length, 4);
		assert.deepEqual(manifest.campaigns.find(({ id }) => id === String(rich._id)), {
			id: String(rich._id),
			newsletter: "field-notes",
			title: 'Pricing: "charge" more & <better>',
			date: "2026-10-01T08:00:00.000Z",
			status: "sent",
			archiveUrl: "https://field-notes.flockstackmail.com/p/pricing-issue",
			markdown: "campaigns/field-notes/2026-10-01-pricing-issue.md",
			html: "campaigns/field-notes/2026-10-01-pricing-issue.html",
		});
		assert.deepEqual(manifest.images.map(({ path, status, url, error }) => [path, status, url, error]), [
			["images/cover-1111.png", "done", `${IMAGE_HOST}/accounts/a/cover-1111.png`, undefined],
			["images/gone-2222.png", "missing", `${IMAGE_HOST}/accounts/a/gone-2222.png`, "HTTP 404"],
		]);
		for (const { path, bytes: size, crc32: crc } of manifest.files) {
			assert.equal(zip.get(path).length, size, path);
			assert.equal(zlib.crc32(zip.get(path)).toString(16).padStart(8, "0"), crc, path);
		}

		const email = platformEmails.findLast(({ to }) => to.includes("export-owner@example.com"));
		assert.equal(email.subject, "Your FlockStack export is ready");
		assert.ok(email.text.includes(latest.body.downloadUrls[0]), "the owner gets the link");
		assert.equal(latest.body.emailed, true);
		assert.ok(new Date(latest.body.expiresAt) - Date.now() > 6.9 * 24 * 3_600_000, "the link works for a week");
	});

	test("is built over several jobs when a step only does one unit, with the same files", async () => {
		const user = await customer("export-chunks@example.com");
		await addContacts(user, Array.from({ length: 4300 }, (_, index) => ({ email: `reader${String(index).padStart(5, "0")}@example.org`, status: "active" })));
		for (let index = 0; index < 45; index += 1) await addIssue(user, { subject: `Issue ${index}`, archiveSlug: `chunk-issue-${index}`, html: `<p>Body ${index}</p>`, sentAt: new Date(Date.UTC(2026, 0, 1 + index)) });

		process.env.EXPORT_STEP_MS = "0";
		const jobsBefore = published.length;
		try {
			const { results, latest } = await exportAndWait(user);
			assert.ok(results.length > 8, `${results.length} jobs, each publishing the next`);
			assert.ok(results.slice(0, -1).every((result) => result.continued), "every job but the last continues");
			assert.equal(published.length - jobsBefore, results.length, "one job at a time");
			assert.equal(latest.body.status, "ready");
			assert.equal(latest.body.counts.contacts, 4300);
			assert.equal(latest.body.counts.campaigns, 45);

			const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
			const rows = zip.get(`contacts/${user.newsletter.slug}.csv`).toString().trim().split("\r\n");
			assert.equal(rows.length, 4301, "the header and every contact, once, across three parts");
			assert.equal(new Set(rows).size, 4301);
			assert.deepEqual([...zip.keys()].filter((path) => path.endsWith(".md")).length, 45);
		} finally {
			delete process.env.EXPORT_STEP_MS;
		}
	});

	test("answers the one being made instead of starting a second", async () => {
		const user = await customer("export-twice@example.com");
		const first = await m.exports.startAccountExport({ account: user.account, via: "api" });
		const second = await m.exports.startAccountExport({ account: user.account, via: "api" });
		assert.equal(first.isNew, true);
		assert.deepEqual([second.isNew, String(second.exportDoc._id)], [false, String(first.exportDoc._id)]);
		await runJobs();
		assert.equal((await m.exports.findLatestExport(user.account)).status, "ready");
	});

	test("a step run twice leaves the same files, and a duplicate job waits for the one running", async () => {
		const user = await customer("export-retry@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		await addIssue(user, { subject: "Only", archiveSlug: "only-issue", html: "<p>Only</p>" });
		const { exportDoc } = await m.exports.startAccountExport({ account: user.account, via: "api" });
		const job = { accountId: String(user.accountId), exportId: String(exportDoc._id) };
		process.env.EXPORT_STEP_MS = "0";
		try {
			assert.deepEqual(await m.exports.runExportStep(job), { continued: "csv" });
			await m.AccountExport.updateOne({ accountId: user.accountId, _id: exportDoc._id }, { $set: { lockedUntil: new Date(Date.now() + 60_000) } });
			assert.deepEqual(await m.exports.runExportStep(job), { busy: true }, "a step in progress holds the export");
			await m.AccountExport.updateOne({ accountId: user.accountId, _id: exportDoc._id }, { $unset: { lockedUntil: 1 } });
			await m.AccountExport.updateOne({ accountId: user.accountId, _id: exportDoc._id }, { $set: { state: { phase: "csv", n: 0, after: null, part: 0, crc: 0, size: 0, rows: 0, keys: [], counts: { contacts: 0, campaigns: 0, images: 0, missingImages: 0 } } } });
			await m.exports.runExportStep(job);
		} finally {
			delete process.env.EXPORT_STEP_MS;
		}
		await runJobs();
		const done = await m.exports.findExport(user.account, exportDoc._id);
		assert.equal(done.status, "ready");
		assert.equal(await m.ExportFile.countDocuments({ accountId: user.accountId, exportId: exportDoc._id, path: `contacts/${user.newsletter.slug}.csv` }), 1);
		const zip = readZip(await readResponseBytes(await download(m.exports.getExportDownloadUrls(done)[0])));
		assert.equal(zip.get(`contacts/${user.newsletter.slug}.csv`).toString().trim().split("\r\n").length, 2);
		assert.equal((await m.exports.runExportStep(job)).skipped, "ready", "a job delivered after the end does nothing");
	});

	test("fails after three steps that throw, removes what it wrote and tells the owner", async () => {
		const user = await customer("export-failing@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		const started = await callApi("POST", "/api/v1/account/export", { key: user.key });
		const job = { accountId: String(user.accountId), exportId: started.body.id };
		const exportDoc = { _id: started.body.id };
		process.env.EXPORT_STORAGE = "";
		try {
			await assert.rejects(m.exports.runExportStep(job), /No storage/);
			await assert.rejects(m.exports.runExportStep(job), /No storage/);
			assert.equal((await m.exports.findExport(user.account, exportDoc._id)).status, "running", "tried again by QStash");
			const last = await m.exports.runExportStep(job);
			assert.match(last.failed, /No storage/);
		} finally {
			process.env.EXPORT_STORAGE = "memory";
		}
		const failed = await m.exports.findExport(user.account, exportDoc._id);
		assert.equal(failed.status, "failed");
		assert.match(failed.error, /No storage/);
		assert.equal(platformEmails.findLast(({ to }) => to.includes("export-failing@example.com")).subject, "[FlockStack] Your export didn't finish");
		const again = await callApi("POST", "/api/v1/account/export", { key: user.key });
		assert.equal(again.status, 429, "the rate limit counted the first try");
	});

	test("goes after a week: the link stops, the files and records are removed", async () => {
		const user = await customer("export-expiry@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		const { latest } = await exportAndWait(user);
		const url = latest.body.downloadUrls[0];
		const id = latest.body.id;
		const prefix = `exports/${user.accountId}/${id}/`;
		assert.ok([...memoryObjects.keys()].some((key) => key.startsWith(prefix)));
		assert.equal((await download(url)).status, 200);

		const stale = createAccountExportToken({ accountId: user.accountId, exportId: id, expiresAt: new Date(Date.now() - 1000) });
		assert.equal((await download(`http://localhost:3000/api/v1/account/export.zip?token=${stale}`)).status, 401, "a link carries its own expiry");
		await m.AccountExport.updateOne({ accountId: user.accountId, _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		assert.equal((await download(url)).status, 410, "and the record's expiry stops it too");

		assert.equal(await m.exports.expireAccountExports(), 1);
		assert.equal([...memoryObjects.keys()].filter((key) => key.startsWith(prefix)).length, 0);
		assert.equal(await m.ExportFile.countDocuments({ accountId: user.accountId, exportId: id }), 0);
		const expired = await callApi("GET", `/api/v1/account/export?id=${id}`, { key: user.key });
		assert.deepEqual([expired.body.status, expired.body.downloadUrls], ["expired", []]);
	});

	test("refuses a forged link, another account's export and a part that doesn't exist", async () => {
		const owner = await customer("export-links@example.com");
		const stranger = await customer("export-stranger@example.com");
		const { latest } = await exportAndWait(owner);
		const token = new URL(latest.body.downloadUrls[0]).searchParams.get("token");
		const url = (query) => `http://localhost:3000/api/v1/account/export.zip?${query}`;
		assert.equal((await download(url(`token=${token}x`))).status, 401);
		assert.equal((await download(url("token=nonsense"))).status, 401);
		assert.equal((await download(url(""))).status, 401);
		assert.equal((await download(url(`token=${token}&part=2`))).status, 404);
		assert.equal((await download(url(`token=${token}&part=0`))).status, 404);
		const crossed = createAccountExportToken({ accountId: stranger.accountId, exportId: latest.body.id, expiresAt: new Date(Date.now() + 60_000) });
		assert.equal((await download(url(`token=${crossed}`))).status, 410, "a token for another account finds nothing");
		const asStranger = await callApi("GET", `/api/v1/account/export?id=${latest.body.id}`, { key: stranger.key });
		assert.equal(asStranger.status, 404);
	});

	test("downloads a large export one part at a time", async () => {
		const user = await customer("export-parts@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		await addIssue(user, { subject: "One", archiveSlug: "parts-one", html: "<p>One</p>" });
		const { latest } = await exportAndWait(user);
		const files = await m.ExportFile.find({ accountId: user.accountId, exportId: latest.body.id }).sort({ order: 1 }).lean();
		const middle = files.findIndex(({ path }) => path.startsWith("contacts/"));
		await m.AccountExport.updateOne({ accountId: user.accountId, _id: latest.body.id }, { $set: { volumeStarts: [files[0].order, files[middle].order] } });
		const urls = m.exports.getExportDownloadUrls(await m.exports.findExport(user.account, latest.body.id));
		assert.equal(urls.length, 2);
		assert.match(urls[1], /&part=2$/);
		const first = readZip(await readResponseBytes(await download(urls[0])));
		const second = readZip(await readResponseBytes(await download(urls[1])));
		assert.deepEqual([...first.keys(), ...second.keys()], files.map(({ path }) => path));
		assert.deepEqual([...first.keys()].some((path) => path.startsWith("contacts/")), false);
		assert.match((await download(urls[1])).headers.get("content-disposition"), /-part-2-of-2\.zip/);
	});
});

describe("an account that is blocked, paused or has no plan", () => {
	test("can still export, by API key and from the dashboard, while its other actions stay refused", async () => {
		const user = await customer("export-blocked@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		await addIssue(user, { subject: "Before", archiveSlug: "before-block", html: "<p>Before</p>" });
		assert.equal(await m.blocks.blockAccount(user.accountId, { reason: "Gmail spam rate", by: "gmail" }), true);

		const refused = await callApi("POST", "/api/v1/contacts/import", { key: user.key, body: { consent: true, contacts: [{ email: "new@example.org" }] } });
		assert.equal(refused.status, 403);
		assert.equal(refused.body.error.code, "account_blocked");

		const { started, latest } = await exportAndWait(user);
		assert.equal(started.status, 202);
		assert.equal(latest.body.status, "ready");
		const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
		assert.ok(zip.has(`contacts/${user.newsletter.slug}.csv`));
		assert.equal([...zip.keys()].filter((path) => path.endsWith(".md")).length, 1);
		const email = platformEmails.findLast(({ to }) => to.includes("export-blocked@example.com"));
		assert.equal(email.subject, "Your FlockStack export is ready", "the owner's email isn't the account's own sending, which is stopped");
	});

	test("and one without a plan, whose other actions answer subscription_required", async () => {
		const user = await customer("export-noplan@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });

		const listed = await callApi("GET", "/api/v1/campaigns", { key: user.key });
		assert.equal(listed.status, 402);
		assert.equal(listed.body.error.code, "subscription_required");
		const { started, latest } = await exportAndWait(user);
		assert.equal(started.status, 202);
		assert.equal(latest.body.status, "ready");
		const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
		assert.equal(zip.get(`contacts/${user.newsletter.slug}.csv`).toString().trim().split("\r\n").length, 2);
	});

	test("and the dashboard's own call, which is limited to one export every five minutes", async () => {
		const user = await customer("export-dashboard@example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled", status: "paused", pauseReason: "an admin" } });
		const account = await m.Account.findById(user.accountId).lean();
		const first = await m.runAction("export_account_data", { account, user: { id: user.userId, email: user.email }, via: "dashboard" });
		assert.equal(first.started, true);
		await assert.rejects(
			m.runAction("export_account_data", { account, user: { id: user.userId, email: user.email }, via: "dashboard" }),
			{ code: "rate_limited", message: "You can export all account data once every 5 minutes. Try again later." }
		);
		await assert.rejects(m.runAction("export_account_data", { account, via: "api", apiKey: { _id: user.accountId, level: "full" } }), { code: "rate_limited" });
	});
});

describe("the account page", () => {
	const render = (user) => as(user, async () => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.accountPage.default())));

	test("starts an export, shows it being made and then its links, also for a blocked account", async () => {
		const user = await customer("export-page@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		assert.match(await render(user), /Export everything/);
		assert.doesNotMatch(await render(user), /Download ZIP/);

		const started = await as(user, () => m.exportActions.startExport());
		assert.equal(started.export.status, "queued");
		assert.match(await render(user), /Preparing your export/);
		assert.deepEqual((await as(user, () => m.exportActions.getExportStatus())).export.downloadUrls, []);

		await runJobs();
		const ready = (await as(user, () => m.exportActions.getExportStatus())).export;
		assert.equal(ready.status, "ready");
		const page = await render(user);
		assert.match(page, /Download ZIP/);
		assert.ok(page.includes(ready.downloadUrls[0].replaceAll("&", "&amp;")), "the page links to the ZIP");

		await m.blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		assert.match(await render(user), /Download ZIP/, "a blocked account sees its export too");
		assert.match((await as(user, () => m.exportActions.startExport())).error, /once every 5 minutes/);
	});
});
