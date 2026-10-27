import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { proveVolume, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, loadSendingModules, runJobs, sendRoutes } from "./helpers/sending.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { sponsorCreative, sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(QSTASH_KEYS); fake = installFakeStripe(); m = { ...(await sponsorshipModels()), service: await import("../lib/sponsorship-campaigns.js"), blocks: await import("../lib/sponsorship-blocks.js"), billing: await import("../lib/sponsorship-billing.js"), reports: await import("../lib/sponsorship-reports.js"), clean: await import("../lib/clean-html.js"), render: await import("../lib/sending-rules.js"), clickLinks: await import("../lib/link-clicks.js"), sending: await import("../lib/sending.js"), sendModules: await loadSendingModules(), Campaign: (await import("../models/Campaign.js")).default, CampaignLink: (await import("../models/CampaignLink.js")).default, Message: (await import("../models/Message.js")).default }; });
after(() => app?.stop());
async function setup() {
	const s = await sponsorshipSeller(m, fake), request = await sponsorRequest(m, s);
	await m.bookings.verifySponsorshipRequest(request.token);
	await m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: request.booking._id });
	const edited = await m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: request.booking._id, input: sponsorCreative });
	await m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: edited._id, expectedHash: edited.creativeHash, actorId: s.user.account.ownerId });
	const invoiced = await m.billing.createSponsorshipInvoice({ account: s.user.account, bookingId: edited._id });
	Object.assign(fake.invoices.get(invoiced.stripeInvoiceId), { status: "paid", paid: true, amount_paid: 25000 });
	const booking = await m.billing.refreshSponsorshipInvoice({ account: s.user.account, bookingId: edited._id });
	const campaign = (await m.Campaign.create({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, subject: "A sponsored issue", format: "rich", html: "<p>Useful words</p>" })).toObject();
	return { ...s, booking, campaign };
}
async function insert(s) {
	const block = await m.service.prepareSponsorshipBlock({ account: s.user.account, bookingId: s.booking._id, campaignId: s.campaign._id });
	s.campaign.html += block.html;
	await m.Campaign.updateOne({ accountId: s.user.accountId, _id: s.campaign._id }, { $set: { html: s.campaign.html } });
	return block;
}
test("approved sponsor atoms survive cleaning, render labeled literal copy and bind only their own rich draft", async () => {
	const s = await setup(); await insert(s);
	const cleaned = m.clean.cleanRichHtml(s.campaign.html);
	assert.equal(m.blocks.findSponsorshipBlocks(cleaned).length, 1);
	await m.service.assertCampaignSponsorships({ ...s.campaign, html: cleaned });
	const email = m.render.buildRecipientEmail({ campaign: s.campaign, newsletter: s.newsletter, contact: { _id: "1".repeat(24), email: "reader@example.com", tier: "free" }, messageId: "0".repeat(24) });
	assert.match(email.html, /Sponsored/); assert.match(email.html, /A useful sponsor/); assert.match(email.text, /A practical product/);
	assert.deepEqual(m.blocks.renderedSponsorshipIds(email.html), [String(s.booking._id)]);
	assert.equal(email.html.includes("data-sponsorship="), false);
	const other = await setup(); await assert.rejects(m.service.prepareSponsorshipBlock({ account: other.user.account, bookingId: s.booking._id, campaignId: other.campaign._id }), error => error.code === "not_found");
});
test("send checks refuse changed words, destinations, review, billing, other issues, web-only and duplicate blocks", async () => {
	const s = await setup(); const block = await insert(s);
	const parsed = m.blocks.findSponsorshipBlocks(block.html)[0].data;
	for (const change of [{ creative: { ...parsed.creative, url: "https://example.com/changed" } }, { creative: { ...parsed.creative, headline: "Unapproved" } }, { hash: "f".repeat(64) }, { imageUrl: "https://example.com/sponsor-assets/fake" }]) await assert.rejects(m.service.assertCampaignSponsorships({ ...s.campaign, html: m.blocks.sponsorshipBlockHtml({ ...parsed, ...change }) }));
	for (const change of [{ publishTo: "web" }, { kind: "note" }, { format: "html" }, { _id: "1".repeat(24) }, { html: block.html + block.html }]) await assert.rejects(m.service.assertCampaignSponsorships({ ...s.campaign, ...change }));
	await m.Booking.updateOne({ accountId: s.user.accountId, _id: s.booking._id }, { $set: { invoiceFunded: false } });
	await assert.rejects(m.service.assertCampaignSponsorships(s.campaign), /no longer paid/);
});
test("detaching requires the block absent from the saved draft, and sent history cannot be detached", async () => {
	const s = await setup(); await insert(s);
	await assert.rejects(m.service.detachSponsorshipBooking({ account: s.user.account, bookingId: s.booking._id }), /Remove the sponsor block/);
	await m.Campaign.updateOne({ accountId: s.user.accountId, _id: s.campaign._id }, { $set: { html: "<p>Removed</p>", status: "sent" } });
	await assert.rejects(m.service.detachSponsorshipBooking({ account: s.user.account, bookingId: s.booking._id }), /Only a draft/);
	await m.Campaign.updateOne({ accountId: s.user.accountId, _id: s.campaign._id }, { $set: { status: "draft" } });
	assert.equal((await m.service.detachSponsorshipBooking({ account: s.user.account, bookingId: s.booking._id })).detached, true);
});
test("click attribution freezes at send start and reports actual containing messages without identities or inferred delivery", async () => {
	const s = await setup(); await insert(s);
	await m.clickLinks.saveCampaignLinks(s.campaign, s.newsletter);
	const link = await m.CampaignLink.findOne({ accountId: s.user.accountId, campaignId: s.campaign._id, sponsorshipBookingId: s.booking._id }).lean();
	assert.ok(link); assert.equal(link.url, sponsorCreative.url);
	await m.Message.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, campaignId: s.campaign._id, kind: "campaign", email: "reader@example.com", status: "delivered", sentAt: new Date(), deliveredAt: new Date(), sponsorshipBookingIds: [s.booking._id], clickedLinks: [link.index] });
	await m.Message.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, campaignId: s.campaign._id, kind: "campaign", email: "hidden@example.com", status: "sent", sentAt: new Date() });
	await m.Message.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, campaignId: s.campaign._id, kind: "campaign", email: "skipped@example.com", status: "skipped", sponsorshipBookingIds: [s.booking._id] });
	await m.CampaignLink.updateOne({ accountId: s.user.accountId, _id: link._id }, { $set: { clicks: 3, uniqueClicks: 1 } });
	await m.clickLinks.saveCampaignLinks({ ...s.campaign, html: "<p>Changed web page</p>" }, s.newsletter);
	const report = await m.reports.getSponsorshipReport({ account: s.user.account, bookingId: s.booking._id });
	assert.equal(report.issues.length, 1); const issue = report.issues[0];
	assert.equal(issue.providerAcceptedEmails, 1); assert.equal(issue.deliveredEmails, 1); assert.equal(issue.clicks, 3); assert.equal(issue.uniqueMessageClickers, 1);
	assert.equal(JSON.stringify(report).includes("reader@example.com"), false); assert.equal("invoice" in report, false);
	await m.CampaignLink.deleteMany({ accountId: s.user.accountId, campaignId: s.campaign._id });
	const missing = (await m.reports.getSponsorshipReport({ account: s.user.account, bookingId: s.booking._id })).issues[0]; assert.equal(missing.clicks, null); assert.equal(missing.uniqueMessageClickers, null); assert.equal(missing.providerAcceptedEmails, 1);
});
test("merge tags and hand-written reporting attributes cannot impersonate a sponsor", async () => {
	const s = await setup();
	await assert.rejects(m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: s.booking._id, input: { ...sponsorCreative, body: "Hello {{email}}" } }), /merge tags/);
	await assert.rejects(m.service.assertCampaignSponsorships({ ...s.campaign, html: '<a data-sponsor-booking="' + s.booking._id + '" href="https://example.com">Fake</a>' }), /reserved reporting/);
});

test("sponsor click positions remain stable across audience filtering, paywalls and automatic UTM tagging", async () => {
	const s = await setup(); const block = await insert(s);
	const tracking = await import("../lib/tracking.js");
	const newsletter = { ...s.newsletter, utmLinks: true };
	const campaign = { ...s.campaign, html: '<div data-access="free"><p><a href="https://example.com/free-only">Free only</a></p></div>' + block.html };
	const contacts = [{ _id: "1".repeat(24), email: "free@example.com", tier: "free" }, { _id: "2".repeat(24), email: "paid@example.com", tier: "paid", paidUntil: new Date(Date.now() + 86400000) }];
	for (const contact of contacts) {
		const email = m.render.buildRecipientEmail({ campaign, newsletter, contact, messageId: contact._id });
		const sponsor = tracking.readTrackedLinks(email.html).find(link => link.url.startsWith(sponsorCreative.url));
		assert.ok(sponsor); assert.equal(sponsor.index, 100); assert.ok(new URL(sponsor.url).searchParams.get("utm_source"));
		assert.deepEqual(m.blocks.renderedSponsorshipIds(email.html), [String(s.booking._id)]);
	}
	await m.clickLinks.saveCampaignLinks(campaign, newsletter);
	const row = await m.CampaignLink.findOne({ accountId: s.user.accountId, campaignId: campaign._id, sponsorshipBookingId: s.booking._id }).lean();
	assert.equal(row.index, 100); assert.ok(new URL(row.url).searchParams.get("utm_source"));
	const gated = { ...campaign, html: '<p>Free part</p><div data-paywall=""></div>' + block.html };
	const freeEmail = m.render.buildRecipientEmail({ campaign: gated, newsletter, contact: contacts[0], messageId: contacts[0]._id });
	const paidEmail = m.render.buildRecipientEmail({ campaign: gated, newsletter, contact: contacts[1], messageId: contacts[1]._id });
	assert.deepEqual(m.blocks.renderedSponsorshipIds(freeEmail.html), []); assert.deepEqual(m.blocks.renderedSponsorshipIds(paidEmail.html), [String(s.booking._id)]);
	assert.equal(tracking.readTrackedLinks(paidEmail.html).find(link => link.url.startsWith(sponsorCreative.url)).index, 100);
});

test("real send jobs record only accepted containing messages, and revoked funding stops later jobs before the provider", async () => {
	const s = await setup(); await insert(s); await proveVolume(s.user, 1000);
	const contacts = await m.Contact.insertMany([0, 1, 2].map(index => ({ accountId: s.user.accountId, newsletterId: s.newsletter._id, email: `sponsor-reader${index}@example.com`, status: "active", lastSentAt: new Date(Date.now() - 86400000) })));
	await m.sending.queueCampaign({ accountId: s.user.accountId, campaignId: s.campaign._id });
	await m.Contact.updateOne({ accountId: s.user.accountId, _id: contacts[2]._id }, { $set: { status: "unsubscribed" } });
	await runJobs(sendRoutes(m.sendModules));
	const report = await m.reports.getSponsorshipReport({ account: s.user.account, bookingId: s.booking._id });
	assert.equal(report.issues[0].providerAcceptedEmails, 2); assert.equal(report.issues[0].deliveredEmails, 0);
	const sent = await m.Message.find({ accountId: s.user.accountId, campaignId: s.campaign._id, kind: "campaign", sentAt: { $ne: null } }).lean();
	assert.equal(sent.length, 2); assert.ok(sent.every(message => message.sponsorshipBookingIds.map(String).includes(String(s.booking._id))));
	const revoked = await setup(); await insert(revoked); await proveVolume(revoked.user, 1000);
	await m.Contact.create({ accountId: revoked.user.accountId, newsletterId: revoked.newsletter._id, email: "held-sponsor-reader@example.com", status: "active", lastSentAt: new Date(Date.now() - 86400000) });
	await m.sending.queueCampaign({ accountId: revoked.user.accountId, campaignId: revoked.campaign._id });
	await m.Booking.updateOne({ accountId: revoked.user.accountId, _id: revoked.booking._id }, { $set: { invoiceFunded: false } });
	await runJobs(sendRoutes(m.sendModules));
	assert.equal((await m.Campaign.findOne({ accountId: revoked.user.accountId, _id: revoked.campaign._id }).lean()).status, "paused");
	assert.equal(await m.Message.countDocuments({ accountId: revoked.user.accountId, campaignId: revoked.campaign._id, kind: "campaign", sentAt: { $ne: null } }), 0);
});
