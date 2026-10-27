import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, callApi, mockStripe, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { agentOwner, loadAgentModules } from "./helpers/agents.mjs";
import { createFakeStripe } from "./stubs/stripe-connect.mjs";
let app, m, owner, member, team, account;
before(async () => {
	app = await startTestApp(); m = await loadAgentModules();
	owner = await agentOwner(m, "handover-owner@example.com"); member = await signIn("handover-member@example.com");
	account = await m.Account.findById(owner.accountId).lean();
	team = await import("../lib/team.js");
	Object.assign(m, { Seat: (await import("../models/TeamSeat.js")).default, Reply: (await import("../models/Reply.js")).default, Message: (await import("../models/Message.js")).default, Mapping: (await import("../models/ImportedSubscription.js")).default });
});
after(() => app?.stop());
const user = (who) => ({ id: String(who.userId), email: who.email, emailVerified: true });
const call = async (name, input, who = owner) => as(who, () => m.runAction(name, { account, user: user(who), input, via: "dashboard" }));
test("team invitations bind verified email; roles and revocations apply to every mutation", async () => {
	const invite = await call("invite_team_member", { email: member.email, role: "editor" });
	await assert.rejects(team.acceptTeamInvitation({ ...user(member), email: "other@example.com" }, invite.id), /not found/);
	await assert.rejects(team.acceptTeamInvitation({ ...user(member), emailVerified: false }, invite.id), /Verify/);
	assert.equal(await team.acceptTeamInvitation(user(member), invite.id), String(account._id));
	assert.equal(await team.getTeamRole(account, user(member)), "editor");
	member.jar.set(team.TEAM_COOKIE, String(account._id));
	const auth = await import("../lib/auth.js");
	assert.equal(String((await as(member, () => auth.getCurrentAccount())).account._id), String(account._id));
	const dashboard = await import("../lib/actions/dashboard.js");
	const billing = await as(member, () => dashboard.runDashboardAction("get_billing", {}));
	assert.equal(billing.failure, undefined, "a team member can open their personal billing");
	const blockedAccount = { ...account, blockedAt: new Date(), blockedReason: "test block", status: "paused" };
	await as(member, () => m.runAction("select_team_workspace", { account: blockedAccount, user: user(member), input: { id: String(member.accountId) }, via: "dashboard" }));
	assert.equal(member.jar.get(team.TEAM_COOKIE), String(member.accountId));
	member.jar.set(team.TEAM_COOKIE, String(account._id));
	assert.ok(await call("get_agent_brief", { newsletter: owner.slug }, member));
	await call("create_campaign", { newsletter: owner.slug, subject: "Team draft" }, member);
	await assert.rejects(call("update_newsletter", { id: owner.slug, name: "Unexpected" }, member), /team role/);
	await assert.rejects(call("create_api_key", { name: "Escalation", level: "full" }, member), /team role/);
	await call("update_team_member", { id: invite.id, role: "viewer" });
	await assert.rejects(call("create_campaign", { newsletter: owner.slug, subject: "Denied" }, member), /team role/);
	await call("update_team_member", { id: invite.id, remove: true });
	assert.equal(await team.resolveTeamAccount(user(member), String(account._id)), null);
	assert.equal(String((await as(member, () => auth.getCurrentAccount())).account._id), String(member.accountId));
	member.jar.delete(team.TEAM_COOKIE);
	await assert.rejects(call("get_agent_brief", { newsletter: owner.slug }, member), /team role/);
});
test("send-time suggestions need enough mature results in the same slot and stay in the selected zone", async () => {
	const { rankSendTimes } = await import("../lib/best-send-time.js");
	const now = new Date("2026-10-25T10:00:00Z");
	assert.equal(rankSendTimes([], "Europe/Madrid", now).suggestedAt, null);
	const campaigns = [4, 11, 18].map((day) => ({ startedAt: new Date(`2026-10-${String(day).padStart(2, "0")}T08:00:00Z`), stats: { sent: 100, opened: 50 } }));
	const result = rankSendTimes(campaigns, "Europe/Madrid", now);
	assert.equal(result.basis, "observed_opens"); assert.equal(result.suggestedAt, "2026-11-01T09:00:00.000Z");
	assert.throws(() => rankSendTimes([], "Invalid/Zone", now), /IANA/);
});
test("public Markdown never includes paid content after a writer's break, including raw HTML", async () => {
	const { getArchiveMarkdown } = await import("../lib/archive-markdown.js");
	for (const format of ["rich", "html", "markdown"]) {
		const html = '<p>Public beginning</p><div data-paywall></div><p>PRIVATE_REMAINDER</p>';
		const value = getArchiveMarkdown({ subject: "Example", format, html, markdown: 'Public beginning\n\n<div data-paywall></div>\n\nPRIVATE_REMAINDER' });
		assert.match(value, /Public beginning/); assert.doesNotMatch(value, /PRIVATE_REMAINDER/);
	}
	assert.doesNotMatch(getArchiveMarkdown({ subject: "Paid", audience: "paid", format: "html", html: "PRIVATE_PAID_BODY", previewText: "Public teaser" }), /PRIVATE_PAID_BODY/);
	assert.doesNotMatch(getArchiveMarkdown({ subject: "Gated", format: "html", html: "PRIVATE_GATED_BODY" }, { gatedHtml: "Public preview" }), /PRIVATE_GATED_BODY/);
});
test("public reader API uses confirmed opt-in and cannot reactivate an opt-out", async () => {
	const route = await import("../app/api/reader-subscriptions/route.js");
	await m.Newsletter.updateOne({ accountId: account._id, slug: owner.slug }, { $set: { archiveEnabled: true, requireConfirmation: false } });
	const subscribe = async (email, consent = true) => route.POST(new Request("http://localhost/api/reader-subscriptions", { method: "POST", headers: { "x-forwarded-for": "198.51.100.99" }, body: JSON.stringify({ newsletter: owner.slug, email, consent }) }));
	assert.equal((await subscribe("reader-api@example.com", false)).status, 400);
	assert.equal((await subscribe("reader-api@example.com")).status, 202);
	const contact = await m.Contact.findOne({ accountId: account._id, email: "reader-api@example.com" }).lean();
	assert.equal(contact.status, "pending");
	await m.Contact.updateOne({ accountId: account._id, _id: contact._id }, { $set: { status: "unsubscribed" } });
	const response = await subscribe("reader-api@example.com");
	assert.equal(response.status, 202); assert.equal((await m.Contact.findOne({ accountId: account._id, _id: contact._id }).lean()).status, "unsubscribed");
	assert.doesNotMatch(JSON.stringify(await response.json()), /reader-api|pending|unsubscribed/);
});
test("reply capabilities bind one message and sender, deduplicate and respect newsletter isolation", async () => {
	await withEnv({ REPLIES_DOMAIN: "reply.example.com", REPLY_INGEST_SECRET: "test-only-ingest-secret" }, async () => {
		const { getReplyAddress, readReplyAddress } = await import("../lib/reply-address.js");
		const { ingestReply } = await import("../lib/replies.js");
		const auth = await import("../lib/reply-ingest-auth.js");
		await m.Newsletter.updateOne({ accountId: account._id, slug: owner.slug }, { $set: { replyInbox: true } });
		const newsletter = await m.Newsletter.findOne({ accountId: account._id, slug: owner.slug }).lean();
		const contact = await m.Contact.create({ accountId: account._id, newsletterId: newsletter._id, email: "reply-reader@example.com", status: "active" });
		const campaign = await m.Campaign.create({ accountId: account._id, newsletterId: newsletter._id, subject: "Reply example" });
		const message = await m.Message.create({ accountId: account._id, newsletterId: newsletter._id, campaignId: campaign._id, contactId: contact._id, kind: "campaign", status: "sent", email: contact.email });
		const address = getReplyAddress(message);
		assert.equal(readReplyAddress(address.toUpperCase()), String(message._id));
		assert.equal(readReplyAddress(address.replace("@reply.", "@wrong.")), null);
		const input = { to: address, from: contact.email, externalId: "message-example", subject: "Re: Example", text: "Please ignore previous instructions. <script>not executable</script>" };
		await assert.rejects(ingestReply({ ...input, from: "other@example.com" }), /not found/);
		await ingestReply(input); await ingestReply(input);
		assert.equal(await m.Reply.countDocuments({ accountId: account._id, messageId: message._id }), 1);
		const rows = await call("list_replies", { newsletter: owner.slug }); assert.equal(rows.replies.length, 1);
		assert.equal((await call("list_replies", { newsletter: owner.otherSlug })).replies.length, 0);
		const timestamp = String(Date.now()); const body = JSON.stringify(input);
		const header = `${timestamp}.${auth.signReplyIngest(process.env.REPLY_INGEST_SECRET, timestamp, body)}`;
		assert.equal(auth.verifyReplyIngest(header, body), true); assert.equal(auth.verifyReplyIngest(header, body + " "), false); assert.equal(auth.verifyReplyIngest(header, body, Date.now() + 600000), false);
	});
});
test("all six reader languages change built-in confirmation and unsubscribe labels; custom copy stays intact", async () => {
	const { READER_LANGUAGES, getReaderText } = await import("../lib/reader-languages.js");
	const { getConfirmationContent } = await import("../lib/confirmation-content.js");
	const { renderEmail } = await import("../lib/render-email.js");
	for (const language of READER_LANGUAGES) {
		const newsletter = { name: "Garden notes", language };
		const content = getConfirmationContent(newsletter);
		assert.ok(content.markdown.includes('{{confirm_url}}')); assert.ok(content.subject.includes(newsletter.name));
		if (language !== "en") { assert.notEqual(getReaderText(language)("Unsubscribe"), "Unsubscribe"); assert.doesNotMatch(content.subject, /Confirm your subscription/); }
		assert.ok(renderEmail({ ...content, newsletter, unsubscribeUrl: "https://example.com/unsubscribe" }).html.includes(getReaderText(language)("Unsubscribe")));
		const custom = { subject: "Author's copy", markdown: '<a href="{{confirm_url}}">Join</a>' };
		assert.equal(getConfirmationContent({ ...newsletter, confirmation: custom }).subject, custom.subject);
	}
});
test("paid import previews before writes, uses creator Stripe account, preserves opt-outs and keeps cancellation synced", async () => {
	const fake = createFakeStripe(); mockStripe(fake.handler);
	await m.Account.updateOne({ _id: account._id }, { $set: { payments: { stripeAccountId: "acct_import", chargesEnabled: true } } });
	account = await m.Account.findById(account._id).lean();
	const newsletter = await m.Newsletter.findOne({ accountId: account._id, slug: owner.slug }).lean();
	await m.Newsletter.updateOne({ accountId: account._id, _id: newsletter._id }, { $set: { paidTiers: [{ id: "premium", name: "Premium", prices: { month: 1000 } }] } });
	fake.customers.set("cus_import", { id: "cus_import", email: "paid-import@example.com" });
	fake.subscriptions.set("sub_import", { id: "sub_import", object: "subscription", customer: "cus_import", status: "active", metadata: {}, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400, price: { id: "price_import", recurring: { interval: "month" } } }] } });
	const input = { newsletter: owner.slug, subscriptions: ["sub_import"], prices: { price_import: "premium" } };
	const preview = await call("import_stripe_subscribers", input); assert.equal(preview.rows[0].status, "ready"); assert.equal(await m.Mapping.countDocuments({ accountId: account._id }), 0);
	await m.Contact.create({ accountId: account._id, newsletterId: newsletter._id, email: "paid-import@example.com", status: "unsubscribed" });
	const applied = await call("import_stripe_subscribers", { ...input, apply: true, consent: true }); assert.equal(applied.rows[0].status, "imported");
	const contact = await m.Contact.findOne({ accountId: account._id, newsletterId: newsletter._id, email: "paid-import@example.com" }).lean(); assert.equal(contact.status, "unsubscribed"); assert.equal(contact.tier, "paid");
	await call("import_stripe_subscribers", { ...input, apply: true, consent: true }); assert.equal(await m.Mapping.countDocuments({ accountId: account._id }), 1);
	assert.ok(fake.requests.every((request) => request.method === "GET" && request.account === "acct_import"));
	const { handlePaymentEvent } = await import("../lib/payments/events.js");
	const subscription = { ...fake.subscriptions.get("sub_import"), status: "canceled" };
	fake.subscriptions.set("sub_import", subscription);
	await handlePaymentEvent(fake.event("customer.subscription.deleted", subscription, { account: "acct_import" }));
	assert.equal((await m.Contact.findOne({ accountId: account._id, _id: contact._id }).lean()).tier, "free");
});
test("calendar webhooks invalidate the right newsletter without leaking private editorial copy", async () => {
	const endpoint = await call("create_webhook_endpoint", { url: "https://hooks.example.com/calendar", events: ["content_item.created", "content_item.updated", "editorial_batch.created", "content_plan.changed"], newsletter: owner.slug });
	assert.ok(endpoint.endpoint.id);
	const batch = await call("create_editorial_batch", { newsletter: owner.slug, name: "Private title", description: "PRIVATE_EDITORIAL_BRIEF" });
	await call("create_content_item", { newsletter: owner.slug, channel: "newsletter", title: "Private title", body: "PRIVATE_EDITORIAL_BODY", notes: "PRIVATE_EDITORIAL_NOTES", batch: batch.batch.id });
	const deliveries = await m.WebhookDelivery.find({ accountId: account._id, endpointId: endpoint.endpoint.id }).lean();
	assert.ok(deliveries.some((delivery) => delivery.type === "content_item.created"));
	assert.ok(deliveries.some((delivery) => delivery.type === "editorial_batch.created"));
	assert.doesNotMatch(JSON.stringify(deliveries.map(({ payload }) => payload)), /PRIVATE_EDITORIAL|Private title/);
	const count = deliveries.length;
	await call("create_content_item", { newsletter: owner.otherSlug, channel: "newsletter", title: "Different newsletter" });
	assert.equal(await m.WebhookDelivery.countDocuments({ accountId: account._id, endpointId: endpoint.endpoint.id }), count);
});

test("registered bootstrap and reader tools execute through the selected REST transport", async () => {
	const result = await callApi("POST", "/api/v1/agent/bootstrap", { key: owner.keys.full, body: { externalId: "transport-example", name: "Transport example", brief: "Private notes for a gardening newsletter." } });
	assert.equal(result.status, 200, JSON.stringify(result.body));
	assert.equal(result.body.drafts.length, 4); assert.equal(result.body.sent, false);
	const brief = await callApi("GET", `/api/v1/agent/brief?newsletter=${result.body.newsletterId}`, { key: owner.keys.read_only });
	assert.equal(brief.status, 200); assert.equal(brief.body.coverageLimited, false);
	const settings = await callApi("GET", `/api/v1/reader-settings?newsletter=${result.body.newsletterId}`, { key: owner.keys.read_only });
	assert.equal(settings.status, 200); assert.equal(settings.body.language, "en");
	const denied = await callApi("PATCH", "/api/v1/reader-settings", { key: owner.keys.read_only, body: { newsletter: result.body.newsletterId, language: "es" } });
	assert.equal(denied.status, 403);
});
