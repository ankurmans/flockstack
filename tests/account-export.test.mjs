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
		Comment: (await import("../models/Comment.js")).default,
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

test("account export includes group seats and source records without authentication leases or link versions", async () => {
	const user = await customer("export-groups@example.com"), other = await customer("export-groups-other@example.com");
	const Group = (await import("../models/GroupSubscription.js")).default;
	const [reader] = await addContacts(user, [{ email: "seat-export@example.com", status: "active", paidPersonal: { kind: "stripe", status: "active", tierId: "paid", until: new Date("2027-01-01") }, paidPersonalLease: "PRIVATE_PERSONAL_LEASE" }]);
	const make = (owner, email) => Group.create({ accountId: owner.accountId, newsletterId: owner.newsletter._id, buyerEmail: email, tierId: "paid", option: "month", requestedSeats: 2, chargeAccount: "direct", billingLease: "PRIVATE_GROUP_LEASE", managerVersion: 927451, stripeSubscriptionId: `sub_export_${owner === user ? "owned" : "foreign"}`, seats: [{ id: "synthetic-seat-id", email: reader.email, contactId: reader._id, status: "active", consentedAt: new Date(), invitationVersion: 816342 }] });
	await make(user, "buyer-export@example.com"); await make(other, "FOREIGN_GROUP_ADDRESS@example.com");
	const { latest } = await exportAndWait(user); assert.equal(latest.body.status, "ready");
	const files = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
	const groups = files.get("group-subscriptions.csv").toString();
	assert.match(groups, /buyer-export@example.com/); assert.match(groups, /seat-export@example.com/); assert.match(groups, /consentedAt/);
	assert.doesNotMatch(groups, /PRIVATE_GROUP_LEASE|927451|816342|FOREIGN_GROUP_ADDRESS|managerVersion|invitationVersion/);
	const sources = files.get("reader-paid-sources.csv").toString(); assert.match(sources, /stripe/); assert.doesNotMatch(sources, /PRIVATE_PERSONAL_LEASE/);
	assert.ok((await import("../lib/account-purge.js")).CONTENT_MODELS.includes(Group));
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
			{ email: "ann@example.org", listIds: ["weekly-list"], status: "active", source: "website", subscribedAt: new Date("2026-01-02T10:00:00Z"), confirmedAt: new Date("2026-01-02T10:05:00Z"), stats: { sent: 4, opens: 3, clicks: 1 }, lastOpenAt: new Date("2026-09-01T00:00:00Z") },
			{ email: "bob@example.org", status: "unsubscribed", source: "api", unsubscribedAt: new Date("2026-03-03T00:00:00Z") },
			{ email: "=SUM(1;1)@example.org", status: "pending" },
		]);
		await addContacts(user, [{ email: "cat@example.org", status: "active" }], second._id);
		await m.Suppression.create({ accountId: user.accountId, email: "gone@example.org", reason: "bounce", detail: "550 no such user" });

		const mine = await m.Upload.create({ accountId: user.accountId, url: `${IMAGE_HOST}/accounts/a/cover-1111.png`, pathname: "accounts/a/cover-1111.png", contentType: "image/png", bytes: PNG.length });
		const ApiKey = (await import("../models/ApiKey.js")).default;
		await ApiKey.create({ accountId: user.accountId, newsletterId: user.newsletter._id, purpose: "assistant", name: "EXPORTED_ASSISTANT_GRANT", prefix: "Internal assistant", hash: "synthetic-own-assistant-hash", level: "drafts", dailyCap: 100, expiresAt: new Date("2027-01-01T00:00:00Z") });
		await m.Upload.updateOne({ accountId: user.accountId, _id: mine._id }, { $set: { generatedBy: "synthetic-own-model", generatedAt: new Date("2026-10-25T00:00:00Z") } });
		await m.Upload.create({ accountId: user.accountId, url: `${IMAGE_HOST}/accounts/a/gone-2222.png`, pathname: "accounts/a/gone-2222.png", contentType: "image/png", bytes: 10 });
		const other = await customer("export-other@example.com", { slug: "other-notes" });
		await m.Upload.create({ accountId: other.accountId, url: `${IMAGE_HOST}/accounts/b/theirs-3333.png`, pathname: "accounts/b/theirs-3333.png", contentType: "image/png", bytes: 10, generatedBy: "synthetic-foreign-model", generatedAt: new Date() });

		const rich = await addIssue(user, {
			subject: 'Pricing: "charge" more & <better>',
			previewText: "Charge more than feels right.",
			archiveSlug: "pricing-issue",
			html: `<h2>Hello</h2><p>Look <strong>here</strong></p><p><img src="${mine.url}" alt="cover"></p><p><img src="${IMAGE_HOST}/accounts/a/gone-2222.png" alt="lost"></p><p><img src="${IMAGE_HOST}/accounts/b/theirs-3333.png" alt="not mine"></p>`,
		});
		await addIssue(user, { subject: "Markdown one", archiveSlug: "markdown-one", format: "markdown", markdown: `# Title\n\nSome **bold** text ![cover](${mine.url})`, sentAt: new Date("2026-10-08T08:00:00Z") });
		await addIssue(user, { subject: "Designed", archiveSlug: "designed", format: "html", html: "<!doctype html><html><head><title>x</title></head><body><h1>Designed issue</h1><p>Body</p></body></html>" });
		await addIssue(user, { subject: "Unfinished draft", status: "draft", html: "<p>Still writing</p>", sentAt: undefined, startedAt: undefined });

		const MeteredRead = (await import("../models/MeteredRead.js")).default;
		const annContact = await m.Contact.findOne({ accountId: user.accountId, email: "ann@example.org" }).lean();
		await MeteredRead.create({ accountId: user.accountId, newsletterId: user.newsletter._id, contactId: annContact._id, period: "2026-10", count: 1, issueIds: [String(rich._id)], expiresAt: new Date("2026-11-08") });
		await MeteredRead.create({ accountId: other.accountId, newsletterId: other.newsletter._id, contactId: annContact._id, period: "PRIVATE_OTHER_ACCOUNT", count: 0, expiresAt: new Date("2026-11-08") });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletter._id }, { $set: { mailingLists: [{ id: "weekly-list", name: "Weekly", description: "Fridays", archived: false }], meteredReadsPerMonth: 2 } });
		await m.Contact.updateOne({ accountId: user.accountId, _id: annContact._id }, { $set: { "community.supporterBadge": true, "community.badgeUpdatedAt": new Date("2026-10-25T00:00:00Z") } });
		const foreignBadge = await m.Contact.create({ accountId: other.accountId, newsletterId: other.newsletter._id, email: "foreign-badge@example.com", status: "active", community: { supporterBadge: true, badgeUpdatedAt: new Date("2026-10-25T00:00:00Z") } });
		const CreatorConversation = (await import("../models/CreatorConversation.js")).default;
		const CreatorMessage = (await import("../models/CreatorMessage.js")).default;
		const ownConversation = await CreatorConversation.create({ accountId: user.accountId, newsletterId: user.newsletter._id, otherNewsletterId: other.newsletter._id, otherName: "Other creator" });
		await CreatorMessage.create({ accountId: user.accountId, newsletterId: user.newsletter._id, conversationId: ownConversation._id, messageKey: "export-own", fromNewsletterId: user.newsletter._id, toNewsletterId: other.newsletter._id, fromName: "Creator", body: "Private own introduction", direction: "outgoing" });
		const foreignConversation = await CreatorConversation.create({ accountId: other.accountId, newsletterId: other.newsletter._id, otherNewsletterId: user.newsletter._id, otherName: "Creator" });
		const SubscriptionFinancial = (await import("../models/SubscriptionFinancial.js")).default;
		const SubscriptionChange = (await import("../models/SubscriptionChange.js")).default;
		const SubscriptionInvoice = (await import("../models/SubscriptionInvoice.js")).default;
		await SubscriptionFinancial.create({ accountId: user.accountId, newsletterId: user.newsletter._id, subscriptionId: "sub_export_own", state: { currency: "eur", status: "active", monthlyRecurringMinor: 1000 }, firstObservedAt: new Date(), observedAt: new Date(), source: "refresh" });
		await SubscriptionFinancial.create({ accountId: other.accountId, newsletterId: other.newsletter._id, subscriptionId: "sub_export_foreign", state: { currency: "usd", status: "active", monthlyRecurringMinor: 9999 }, firstObservedAt: new Date(), observedAt: new Date(), source: "refresh" });
		await SubscriptionChange.create({ accountId: user.accountId, newsletterId: user.newsletter._id, subscriptionId: "sub_export_own", eventKey: "financial-export-own", after: { currency: "eur", monthlyRecurringMinor: 1000 }, at: new Date(), source: "refresh", providerEventId: "evt_finance_export_own" });
		await SubscriptionInvoice.create({ accountId: user.accountId, newsletterId: user.newsletter._id, subscriptionId: "sub_export_own", invoiceId: "in_export_own", currency: "eur", amountPaidMinor: 1000, paidAt: new Date(), observedAt: new Date(), sourceAt: new Date(), source: "refresh" });
		await SubscriptionInvoice.create({ accountId: other.accountId, newsletterId: other.newsletter._id, subscriptionId: "sub_export_foreign", invoiceId: "in_export_foreign", currency: "usd", amountPaidMinor: 9999, paidAt: new Date(), observedAt: new Date(), sourceAt: new Date(), source: "refresh" });

		await CreatorMessage.create({ accountId: other.accountId, newsletterId: other.newsletter._id, conversationId: foreignConversation._id, messageKey: "export-foreign", fromNewsletterId: other.newsletter._id, toNewsletterId: user.newsletter._id, fromName: "Other", body: "Foreign only message fixture", direction: "outgoing" });

		const Offer = (await import("../models/Offer.js")).default;
		await Offer.create({ accountId: user.accountId, newsletterId: user.newsletter._id, name: "EXPORTED_TRIAL_FEE", code: "export-trial", type: "trial", trialDays: 14, trialAmountCents: 150, currency: "eur", trialNoCard: false });
		await Offer.create({ accountId: other.accountId, newsletterId: other.newsletter._id, name: "FOREIGN_TRIAL_FEE", code: "private-trial", type: "trial", trialDays: 14, trialAmountCents: 100, currency: "usd" });
		const Form = (await import("../models/Form.js")).default;
		const flowForm = await Form.create({ accountId: user.accountId, newsletterId: user.newsletter._id, name: "EXPORTED_SIGNUP_FLOW", flow: [{ type: "upsell" }], redirectUrl: "https://example.com/finished" });
		await Form.create({ accountId: other.accountId, newsletterId: other.newsletter._id, name: "FOREIGN_SIGNUP_FLOW", flow: [] });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletter._id }, { $set: { signupFlowFormId: flowForm._id } });
		const ReferralCode = (await import("../models/ReferralCode.js")).default;
		const ReferralReward = (await import("../models/ReferralReward.js")).default;
		const Gift = (await import("../models/Gift.js")).default;
		const receipt = await ReferralReward.create({ accountId: user.accountId, newsletterId: user.newsletter._id, contactId: annContact._id, rewardId: "aabbccddeeff", referrals: 1, benefit: { kind: "code", title: "Private inventory" }, state: "ready" });
		await ReferralCode.create({ accountId: user.accountId, newsletterId: user.newsletter._id, rewardId: "aabbccddeeff", code: "EXPORT_EXACT_CODE", codeHash: "synthetic-code-hash", receiptId: receipt._id, assignedAt: new Date() });
		await ReferralCode.create({ accountId: other.accountId, newsletterId: other.newsletter._id, rewardId: "aabbccddeeff", code: "FOREIGN_PRIVATE_CODE", codeHash: "foreign-synthetic-code-hash" });
		const gift = await Gift.create({ accountId: user.accountId, newsletterId: user.newsletter._id, tierId: "paid", months: 1, amountCents: 0, currency: "usd", buyerEmail: "writer@example.com", recipientEmail: annContact.email, deliverOn: new Date(), status: "redeemed", referralRewardId: receipt._id });
		await m.Contact.updateOne({ accountId: user.accountId, _id: annContact._id }, { $set: { [`giftReceipts.${gift._id}`]: "2027-01-31T00:00:00.000Z" } });
		const Automation = (await import("../models/Automation.js")).default;
		const Message = (await import("../models/Message.js")).default;
		const flow = await Automation.create({ accountId: user.accountId, newsletterId: user.newsletter._id, name: "Exportable A/B", trigger: { type: "api" }, steps: [{ id: "welcome", type: "email", subject: "Base", format: "markdown", markdown: "Base body", variants: [{ id: "a", percent: 50 }, { id: "b", percent: 50, subject: "EXPORTED_VARIANT_COPY" }] }] });
		await Message.create({ accountId: user.accountId, newsletterId: user.newsletter._id, kind: "automation", automationId: flow._id, enrollmentId: annContact._id, stepId: "welcome", contactId: annContact._id, email: annContact.email, automationVariantId: "b", automationVariantName: "Alternative", automationExperimentId: "synthetic-allocation", automationVariantVersion: "synthetic-copy", automationVariantPhase: "test", sentAt: new Date(), status: "sent" });
		await Message.create({ accountId: other.accountId, newsletterId: other.newsletter._id, kind: "automation", automationId: flow._id, enrollmentId: other.accountId, stepId: "private", email: "other@example.com", automationVariantId: "OTHER_ACCOUNT_AB_RECORD" });
		const { started, results, latest } = await exportAndWait(user);
		assert.equal(started.body.status, "queued");
		assert.equal(started.body.started, true);
		assert.deepEqual(started.body.downloadUrls, []);
		assert.ok(results.some((result) => result.ready), JSON.stringify(results));
		assert.equal(latest.body.status, "ready");
		assert.equal(latest.body.downloadUrls.length, 1);
		assert.deepEqual(
			{ ...latest.body.counts, bytes: undefined },
			{ newsletters: 2, contacts: 4, comments: 0, campaigns: 4, images: 1, missingImages: 1, bytes: undefined }
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

		assert.match(text("comment-badges.csv"), new RegExp(`${annContact._id},${user.newsletter._id},true,2026-10-25`));
		assert.doesNotMatch(text("comment-badges.csv"), new RegExp(String(foreignBadge._id)));
		assert.match(text("creator-conversations.csv"), new RegExp(String(ownConversation._id)));
		assert.doesNotMatch(text("creator-conversations.csv"), new RegExp(String(foreignConversation._id)));
		assert.match(text("creator-messages.csv"), /Private own introduction/);
		assert.match(text("subscription-financials.csv"), /sub_export_own/);
		assert.match(text("assistant-grants.csv"), /EXPORTED_ASSISTANT_GRANT/);
		assert.doesNotMatch(text("assistant-grants.csv"), /synthetic-own-assistant-hash|hash/);
		assert.match(text("generated-images.csv"), /synthetic-own-model/);
		assert.doesNotMatch(text("generated-images.csv"), /synthetic-foreign-model/);
		assert.doesNotMatch(text("subscription-financials.csv"), /sub_export_foreign/);
		assert.match(text("subscription-changes.csv"), /evt_finance_export_own/);
		assert.match(text("subscription-invoices.csv"), /in_export_own/);
		assert.doesNotMatch(text("subscription-invoices.csv"), /in_export_foreign/);

		assert.doesNotMatch(text("creator-messages.csv"), /Foreign only message fixture/);

		assert.match(text("offers.csv"), /EXPORTED_TRIAL_FEE/);
		assert.match(text("offers.csv"), /eur,,,14,false,150/);
		assert.doesNotMatch(text("offers.csv"), /FOREIGN_TRIAL_FEE/);
		assert.match(text("forms.csv"), /EXPORTED_SIGNUP_FLOW/);
		assert.match(text("forms.csv"), /upsell/);
		assert.doesNotMatch(text("forms.csv"), /FOREIGN_SIGNUP_FLOW/);
		assert.match(text("referral-codes.csv"), /EXPORT_EXACT_CODE/);
		assert.doesNotMatch(text("referral-codes.csv"), /FOREIGN_PRIVATE_CODE/);
		assert.match(text("referral-rewards.csv"), /Private inventory/);
		assert.match(text("gifts.csv"), new RegExp(String(gift._id)));
		assert.match(text("gift-receipts.csv"), /2027-01-31/);
		assert.match(text("automations.csv"), /EXPORTED_VARIANT_COPY/);
		assert.match(text("automation-tests.csv"), /synthetic-allocation,synthetic-copy,test,sent/);
		assert.doesNotMatch(text("automation-tests.csv"), /OTHER_ACCOUNT_AB_RECORD/);
		assert.match(text("metered-reads.csv"), new RegExp(String(rich._id)));
		assert.match(text("metered-reads.csv"), /2026-10,1/);
		assert.doesNotMatch(text("metered-reads.csv"), /PRIVATE_OTHER_ACCOUNT/);
		const csv = text("contacts/field-notes.csv");
		const [header, ...rows] = csv.trim().split("\r\n");
		assert.equal(header, "email,status,newsletter,source,subscribed_at,confirmed_at,unsubscribed_at,last_sent_at,last_open_at,last_click_at,emails_received,opens,clicks,tags,mailing_list_ids,referrals,referred_by,created_at");
		assert.equal(rows.length, 3);
		const ann = rows.find((row) => row.startsWith("ann@example.org"));
		assert.match(ann, /^ann@example\.org,active,field-notes,website,2026-01-02T10:00:00\.000Z,2026-01-02T10:05:00\.000Z,,,2026-09-01T00:00:00\.000Z,,4,3,1,,weekly-list,0,,/);
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
		assert.deepEqual(manifest.counts, { newsletters: 2, contacts: 4, comments: 0, campaigns: 4, images: 1, missingImages: 1 });
		assert.deepEqual(manifest.newsletters.map(({ slug, contactCount, contactsFile }) => [slug, contactCount, contactsFile]), [["field-notes", 3, "contacts/field-notes.csv"], ["second", 1, "contacts/second.csv"]]);
		assert.equal(manifest.newsletters[0].mailingLists[0].id, "weekly-list");
		assert.equal(manifest.newsletters[0].meteredReadsPerMonth, 2);
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

describe("comments in an export", () => {
	test("come as one CSV per newsletter that has any, with reasons and authors, and are counted", async () => {
		const user = await customer("export-comments@example.com");
		const [ann] = await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		const issue = await addIssue(user, { subject: "Talked about", archiveSlug: "talked-about", html: "<p>Hi</p>" });
		const second = await m.Newsletter.create({ accountId: user.accountId, name: "Quiet notes", slug: "quiet-notes", fromEmail: "hello@quiet-notes.flockstackmail.com" });
		const base = { accountId: user.accountId, newsletterId: user.newsletter._id, campaignId: issue._id };
		const root = await m.Comment.create({ ...base, authorId: ann._id, authorName: "Ann", body: "=SUM(A1) and a comma, and a \"quote\"", status: "published", replyRuleConsentAt: new Date("2026-10-25T12:00:00Z"), replyRuleConsentHash: "consented-body-hash", replyRuleDecision: { outcome: "allow", model: "test-model", confidence: 0.99 } });
		await m.Comment.create({ ...base, parentId: root._id, authorId: ann._id, authorName: "Ann", body: "A held reply", status: "held", reason: "It has a link, and this newsletter reviews comments with links before they show.", decidedBy: "rules" });
		await m.Comment.create({ ...base, authorName: "Deleted reader", body: "From someone who left", status: "published" });

		const { latest } = await exportAndWait(user);
		assert.equal(latest.body.status, "ready");
		assert.equal(latest.body.counts.comments, 3);
		const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
		assert.ok(zip.has(`comments/${user.newsletter.slug}.csv`));
		assert.ok(!zip.has(`comments/${second.slug}.csv`), "no file for a newsletter without comments");
		const csv = zip.get(`comments/${user.newsletter.slug}.csv`).toString();
		assert.match(csv, /consented-body-hash/);
		assert.match(csv, /test-model/);
		assert.equal(csv.split("\r\n")[0], "id,issue_id,parent_id,status,reason,decided_by,author_name,author_email,body,open_reports,edited,created_at,reply_rule_consent_at,reply_rule_consent_hash,reply_rule_example_consent,reply_rule_decision");
		assert.ok(csv.includes(String(issue._id)));
		assert.ok(csv.includes("ann@example.org"), "the owner has the author's address");
		assert.ok(csv.includes("It has a link, and this newsletter reviews comments with links before they show."), "and the reason a comment was held");
		assert.ok(csv.includes('"\'=SUM(A1) and a comma, and a ""quote"""'), "a spreadsheet formula is kept as text");
		assert.ok(csv.includes("Deleted reader"));

		const manifest = JSON.parse(zip.get("manifest.json").toString());
		const entry = manifest.newsletters.find(({ slug }) => slug === user.newsletter.slug);
		assert.deepEqual([entry.commentsFile, entry.commentCount], [`comments/${user.newsletter.slug}.csv`, 3]);
		assert.equal(manifest.newsletters.find(({ slug }) => slug === second.slug).commentsFile, null);
		assert.match(zip.get("README.txt").toString(), /comments\/ {7}One CSV per newsletter that has comments/);
	});
});

describe("the content calendar in an export", () => {
	test("comes as one CSV per newsletter that has planned content, with the copy, the plan, the state and the private notes", async () => {
		const user = await customer("export-content@example.com");
		const second = await m.Newsletter.create({ accountId: user.accountId, name: "Quiet notes", slug: "quiet-notes-two", fromEmail: "hello@quiet-notes-two.flockstackmail.com" });
		const batch = await callApi("POST", "/api/v1/editorial-batches", { key: user.key, body: { name: "November, with a comma" } });
		const created = await callApi("POST", "/api/v1/content-items", {
			key: user.key,
			body: { channel: "linkedin", title: "Replies, not opens", body: "=Words\nover two lines", notes: "Private note", pillar: "Deliverability", plannedDate: "2026-11-10", plannedTime: "09:00", timeZone: "Europe/Paris", batch: batch.body.batch.id, references: [{ url: "https://example.com/source", kind: "evidence", label: "The study" }] },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));

		const { latest } = await exportAndWait(user);
		assert.equal(latest.body.status, "ready");
		const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
		assert.ok(zip.has(`content-calendar/${user.newsletter.slug}.csv`));
		assert.ok(!zip.has(`content-calendar/${second.slug}.csv`), "no file for a newsletter without any");
		const csv = zip.get(`content-calendar/${user.newsletter.slug}.csv`).toString();
		assert.match(csv.split("\r\n")[0], /^id,external_id,channel,title,state,funnel_stage,pillar,batch,planned_date,planned_time,time_zone,/);
		for (const expected of ["Replies, not opens", "Private note", "Deliverability", "2026-11-10", "09:00", "Europe/Paris", "\"November, with a comma\"", "evidence The study https://example.com/source"]) assert.ok(csv.includes(expected), expected);
		assert.ok(csv.includes("\"'=Words"), "a spreadsheet formula is kept as text");
		assert.equal(JSON.parse(zip.get("manifest.json").toString()).counts.contentItems, 1);
		assert.match(zip.get("README.txt").toString(), /content-calendar\/ +One CSV per newsletter that has planned content/);
	});
});

describe("an account that is blocked, paused or back on the Free plan", () => {
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

	test("and one whose plan ended, which is on the Free plan with every action open", async () => {
		const user = await customer("export-noplan@example.com");
		await addContacts(user, [{ email: "ann@example.org", status: "active" }]);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });

		const listed = await callApi("GET", "/api/v1/campaigns", { key: user.key });
		assert.equal(listed.status, 200);
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

describe("custom fields and recommendations", () => {
	test("each newsletter's custom fields are CSV columns and in the manifest, with its recommendations by public slug", async () => {
		const CustomField = (await import("../models/CustomField.js")).default;
		const Recommendation = (await import("../models/Recommendation.js")).default;
		const user = await customer("export-fields@example.com", { slug: "field-cols" });
		const other = await customer("export-recommended@example.com", { slug: "their-notes" });
		await CustomField.create({ accountId: user.accountId, newsletterId: user.newsletter._id, key: "first_name", label: "First name", type: "text" });
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletter._id, email: "dee@example.org", fields: { first_name: "Dee" } });
		await Recommendation.create({
			accountId: user.accountId,
			recommenderId: user.newsletter._id,
			recommendedId: other.newsletter._id,
			recommendedAccountId: other.accountId,
			pitch: "Short notes on pricing",
		});

		const { latest } = await exportAndWait(user);
		assert.equal(latest.body.status, "ready");
		const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
		const text = (path) => zip.get(path)?.toString("utf8");
		const [header, row] = text("contacts/field-cols.csv").trim().split("\r\n");
		assert.ok(header.endsWith(",created_at,first_name"), header);
		assert.ok(row.endsWith(",Dee"), row);
		const [settings] = JSON.parse(text("manifest.json")).newsletters;
		assert.deepEqual(settings.customFields, [{ key: "first_name", label: "First name", type: "text" }]);
		assert.deepEqual(settings.recommendations, [{ newsletter: "their-notes", pitch: "Short notes on pricing", status: "active" }]);
	});
});

test("sponsorship export includes private originals and commercial facts without management capabilities", async () => {
	const user = await customer("export-sponsor@example.com"), other = await customer("export-sponsor-other@example.com");
	const Asset = (await import("../models/SponsorshipAsset.js")).default;
	const Booking = (await import("../models/SponsorshipBooking.js")).default;
	const { files } = await import("./stubs/opennext-cloudflare.mjs");
	const { createHash, randomUUID } = await import("node:crypto");
	const booking = await Booking.create({ accountId: user.accountId, newsletterId: user.newsletter._id, slotId: user.newsletter._id, placementId: user.newsletter._id, placementName: "Sponsor placement", day: "2026-11-20", timeZone: "Europe/Paris", amountMinor: 25000, currency: "eur", email: "sponsor@example.com", brandName: "Example sponsor", externalId: randomUUID(), verifiedAt: new Date(), status: "requested" });
	const key = `accounts/${user.accountId}/sponsorships/${booking._id}/original.png`;
	files.set(key, { bytes: PNG, contentType: "image/png" });
	await Asset.create({ accountId: user.accountId, newsletterId: user.newsletter._id, bookingId: booking._id, key, externalId: randomUUID(), sha256: createHash("sha256").update(PNG).digest("hex"), fileName: "original.png", contentType: "image/png", bytes: PNG.length, status: "ready", publicationConsentAt: new Date() });
	await Asset.create({ accountId: other.accountId, newsletterId: other.newsletter._id, bookingId: other.newsletter._id, key: `accounts/${other.accountId}/sponsorships/private/secret.png`, externalId: randomUUID(), sha256: "0".repeat(64), fileName: "FOREIGN_SPONSOR.png", contentType: "image/png", bytes: PNG.length, status: "ready" });
	const { latest } = await exportAndWait(user); assert.equal(latest.body.status, "ready"); assert.equal(latest.body.counts.sponsorAssets, 1);
	const zip = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
	const paths = [...zip.keys()], original = paths.find(path => path.startsWith("sponsorship-assets/"));
	assert.ok(original); assert.deepEqual(zip.get(original), PNG);
	const csv = zip.get("sponsorships/booking.csv").toString(); assert.match(csv, /sponsor@example.com/); assert.match(csv, /25000/); assert.doesNotMatch(csv, /managerVersion|verificationVersion|invoiceLease|token=/);
	assert.equal(paths.some(path => path.includes("FOREIGN_SPONSOR")), false);
	assert.equal(JSON.parse(zip.get("manifest.json").toString()).counts.sponsorAssets, 1);
});
test("reader billing exports private observations and optional feedback without retry payloads", async () => {
	const user = await customer("reader-billing-export@example.com");
	const Retention = (await import("../models/ReaderRetention.js")).default, Response = (await import("../models/CancellationResponse.js")).default;
	const record = await Retention.create({ accountId: user.accountId, newsletterId: user.newsletter._id, subscriptionId: "sub_export_reader", chargeAccount: "direct", pauseMonths: 3, pauseState: "scheduled", saveUsedAt: new Date(), pending: { kind: "pause", externalId: "a9ae279f-c77d-44fc-9e78-698b2a8989a9", startedAt: new Date(), params: { internal: "PRIVATE_RETRY_PAYLOAD" } } });
	await Response.create({ accountId: user.accountId, newsletterId: user.newsletter._id, retentionId: record._id, externalId: "a9ae279f-c77d-44fc-9e78-698b2a8989a9", reason: "cost", comment: "PRIVATE_SHARED_FEEDBACK", sharedAt: new Date() });
	const { latest } = await exportAndWait(user); assert.equal(latest.body.status, "ready");
	const files = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
	const billing = files.get("reader-retention.csv").toString(), feedback = files.get("cancellation-responses.csv").toString();
	assert.match(billing, /sub_export_reader/); assert.doesNotMatch(billing, /PRIVATE_RETRY_PAYLOAD|pending|lease/); assert.match(feedback, /PRIVATE_SHARED_FEEDBACK/);
	const { CONTENT_MODELS } = await import("../lib/account-purge.js"); assert.ok(CONTENT_MODELS.includes(Retention)); assert.ok(CONTENT_MODELS.includes(Response));
});
test("private editor exports contain owned CRDT history and threads but no session capability", async () => {
	const user = await customer("private-editor-export@example.com"), other = await customer("private-editor-foreign@example.com");
	const Snapshot = (await import("../models/CampaignCollaboration.js")).default, Thread = (await import("../models/EditorThread.js")).default;
	const create = owner => Snapshot.create({ accountId: owner.accountId, newsletterId: owner.newsletter._id, campaignId: owner.newsletter._id, epoch: crypto.randomUUID(), fingerprint: "0".repeat(64), state: owner === user ? "PRIVATE_OWNED_CRDT_STATE" : "FOREIGN_CRDT_STATE", checkpointAt: new Date() });
	const snapshot = await create(user); await create(other);
	await Thread.create({ accountId: user.accountId, newsletterId: user.newsletter._id, campaignId: user.newsletter._id, epoch: snapshot.epoch, externalId: crypto.randomUUID(), authorId: String(user.userId), authorName: "Synthetic editor", body: "PRIVATE_EDITOR_DISCUSSION", mentions: [String(user.userId)], anchor: { start: "relative-start", end: "relative-end", quote: "Private draft excerpt" } });
	const { latest } = await exportAndWait(user); assert.equal(latest.body.status, "ready"); const files = readZip(await readResponseBytes(await download(latest.body.downloadUrls[0])));
	const state = files.get("editor-collaboration.csv").toString(), comments = files.get("editor-threads.csv").toString(); assert.match(state, /PRIVATE_OWNED_CRDT_STATE/); assert.doesNotMatch(state, /FOREIGN_CRDT_STATE|sessionId|ticket|cookie/); assert.match(comments, /PRIVATE_EDITOR_DISCUSSION/); assert.match(comments, /Private draft excerpt/);
});
