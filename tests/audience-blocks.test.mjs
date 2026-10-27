import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { filterAudienceBlocks } from "../lib/audience-blocks.js";
import { cleanRichHtml } from "../lib/clean-html.js";
import { renderEmail } from "../lib/render-email.js";
import { renderWebIssue } from "../lib/web-issue.js";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { as } from "./helpers/app.mjs";
const tiers = [{ id: "paid", name: "Basic" }, { id: "premium", name: "Premium" }];
const newsletter = { name: "Audience notes", slug: "audience-notes", paidTiers: tiers };
const source = '<div data-toc=""></div><h2>SHARED</h2><div data-access="free"><h2>FREE_PROMOTION</h2></div><div data-access="paid"><h2>PAID_SECRET</h2><div data-access="paid" data-min-tier="premium"><h2>PREMIUM_SECRET</h2></div></div>';
let t;
before(async () => { t = await setupAudienceTests({ AUDIO_ENABLED: "true", ELEVENLABS_API_KEY: "synthetic-key", ELEVENLABS_VOICES: JSON.stringify([{ id: "voice_test_01", name: "Example" }]), ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-01-01" }); }); after(() => t?.app.stop());
test("audience blocks filter email HTML, plain text and contents before output, with explicit owner previews", () => {
	assert.equal(cleanRichHtml(source), source);
	for (const [tier, id, wanted, hidden] of [["free", null, "FREE_PROMOTION", /PAID_SECRET|PREMIUM_SECRET/], ["paid", "paid", "PAID_SECRET", /FREE_PROMOTION|PREMIUM_SECRET/], ["paid", "premium", "PREMIUM_SECRET", /FREE_PROMOTION/]]) {
		const email = renderEmail({ format: "rich", html: source, newsletter, readerTier: tier, readerTierId: id }); assert.match(email.html, new RegExp(wanted)); assert.match(email.text, new RegExp(wanted)); assert.doesNotMatch(email.html, hidden); assert.doesNotMatch(email.text, hidden); assert.doesNotMatch(email.html, /data-access|data-min-tier/);
	}
	const preview = renderEmail({ format: "rich", html: source, newsletter }); assert.match(preview.html, /FREE_PROMOTION/); assert.match(preview.html, /PREMIUM_SECRET/);
});
test("web access uses the actual tier, metered readers cannot read a specific tier, and public variants request a session view", () => {
	const issue = { format: "rich", audience: "all", html: source };
	const publicBody = renderWebIssue({ newsletter, issue }); assert.equal(publicBody.kind, "paywall"); assert.equal(publicBody.hasAudienceVariants, true); assert.doesNotMatch(publicBody.html, /PAID_SECRET|PREMIUM_SECRET/);
	const basic = renderWebIssue({ newsletter, issue, isUnlocked: true, reader: { paidTierId: "paid" } }); assert.match(basic.html, /PAID_SECRET/); assert.doesNotMatch(basic.html, /FREE_PROMOTION|PREMIUM_SECRET/);
	const premium = renderWebIssue({ newsletter, issue, isUnlocked: true, reader: { paidTierId: "premium" } }); assert.match(premium.html, /PREMIUM_SECRET/); assert.doesNotMatch(premium.html, /FREE_PROMOTION/);
	const meter = renderWebIssue({ newsletter, issue, isUnlocked: true, readerTier: "metered" }); assert.match(meter.html, /PAID_SECRET/); assert.doesNotMatch(meter.html, /PREMIUM_SECRET/);
	const freeOnly = renderWebIssue({ newsletter, issue: { ...issue, html: '<p>Shared</p><div data-access="free"><p>Promotion</p></div>' } }); assert.equal(freeOnly.kind, "article"); assert.equal(freeOnly.hasAudienceVariants, true);
});
test("malformed, invalid and unavailable tier guards fail closed, including within a snippet", () => {
	for (const html of ['<div data-access="paid"><p>HIDDEN</p>', '<div data-access="unknown"><p>HIDDEN</p></div>', '<div data-access="paid" data-min-tier="deleted"><p>HIDDEN</p></div>']) {
		const cleaned = cleanRichHtml(html); assert.doesNotMatch(filterAudienceBlocks(cleaned, { readerTier: "paid", readerTierId: "premium", tiers }).html, /HIDDEN/);
	}
	const encoded = `<div data-html="${encodeURIComponent('<div data-access="paid"><p>HIDDEN</p></div>')}"></div>`; assert.doesNotMatch(renderEmail({ format: "rich", html: encoded }).html, /HIDDEN/);
});
test("reader unlocks select tier variants freshly and shared audio cannot expose an audience block", async () => {
	const owner = await t.customer("audience-block-owner@example.com"); const m = t.m;
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true, paidTiers: tiers } });
	const publication = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const contact = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "audience-reader@example.com", status: "active", tier: "paid", paidUntil: new Date("2099-01-01"), paidTierId: "premium" });
	const issue = await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, archiveSlug: "audience-issue", status: "sent", subject: "Audience issue", html: source, format: "rich" });
	const reader = { jar: new Map(), ip: "198.51.100.181" }; await as(reader, () => import("../lib/reader-session.js").then((session) => session.startReaderSession(publication, contact._id)));
	const access = await import("../lib/reader-access.js"); const unlock = () => as(reader, () => access.unlockIssueForReader({ slug: owner.slug, post: issue.archiveSlug }));
	assert.match((await unlock()).html, /PREMIUM_SECRET/);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { paidTierId: "paid" } }); assert.doesNotMatch((await unlock()).html, /PREMIUM_SECRET/);
	assert.deepEqual(await as(reader, () => access.getAudioAccess({ newsletter: publication, issue, file: { scope: "public" } })), { ok: false, status: 403 });
	const audio = await import("../lib/audio.js");
	assert.equal(await audio.getIssueAudio(publication, issue), null);
	const account = await m.Account.findById(owner.accountId).lean();
	await assert.rejects(() => audio.createAudioVersion({ account, campaign: issue }), /Audio versions are unavailable for issues with audience blocks/);
	const { firstImageUrl } = await import("../lib/thumbnail.js"); assert.equal(firstImageUrl({ format: "rich", html: '<div data-access="paid"><img src="https://example.com/private.png"></div>' }), null);
});

test("the real per-recipient email renderer selects the current tier, and test emails show all valid variants", async () => {
	const { buildRecipientEmail, TEST_CONTACT_ID } = await import("../lib/sending-rules.js");
	const site = { ...newsletter, _id: "6650f1c2e9b1d4a012345679", fromEmail: "hello@audience-notes.example.com", postalAddress: "1 Main St" }; const campaign = { _id: "6650f1c2e9b1d4a012345678", format: "rich", subject: "Audience issue", html: source };
	const contact = { _id: "6650f1c2e9b1d4a01234567a", email: "reader@example.com", tier: "paid", paidUntil: new Date("2099-01-01"), paidTierId: "premium" };
	assert.match(buildRecipientEmail({ newsletter: site, campaign, contact }).html, /PREMIUM_SECRET/);
	const basic = buildRecipientEmail({ newsletter: site, campaign, contact: { ...contact, paidTierId: "paid" } }); assert.doesNotMatch(basic.html, /PREMIUM_SECRET|FREE_PROMOTION/);
	const free = buildRecipientEmail({ newsletter: site, campaign, contact: { ...contact, tier: "free" } }); assert.doesNotMatch(free.html, /PAID_SECRET|PREMIUM_SECRET/); assert.match(free.html, /FREE_PROMOTION/);
	assert.match(buildRecipientEmail({ newsletter: site, campaign, contact: { ...contact, _id: TEST_CONTACT_ID } }).html, /FREE_PROMOTION/);
});
test("translated audience blocks are checked before inference and after a cached higher-tier response", async () => {
	const m = t.m, owner = await t.customer("audience-translation-owner@example.com");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { readerTranslations: true, archiveEnabled: true, paidTiers: tiers } });
	const publication = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const contact = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "audience-translator@example.com", status: "active", tier: "paid", paidUntil: new Date("2099-01-01"), paidTierId: "premium" });
	await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, status: "sent", archiveSlug: "translated-variants", format: "rich", subject: "Variants", html: source });
	const visitor = { jar: new Map(), ip: "198.51.100.182" }; await as(visitor, () => import("../lib/reader-session.js").then((session) => session.startReaderSession(publication, contact._id)));
	const { setAi } = await import("./stubs/opennext-cloudflare.mjs"); const { translateForReader } = await import("../lib/reader-translation.js");
	setAi({ async run(_model, input) { return { response: `${JSON.parse(input.messages[1].content)}\n[END_TRANSLATION]` }; } });
	try {
		const translate = () => as(visitor, () => translateForReader({ slug: owner.slug, post: "translated-variants", language: "es" }));
		assert.match((await translate()).text, /PREMIUM_SECRET/);
		await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { paidTierId: "paid" } }); const current = await translate(); assert.match(current.text, /PAID_SECRET/); assert.doesNotMatch(current.text, /PREMIUM_SECRET|FREE_PROMOTION/);
	} finally { setAi(null); }
});
