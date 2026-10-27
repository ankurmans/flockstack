import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addSentIssue, addVerifiedDomain, as, callApi, proveVolume, startTestApp, withEnv } from "./helpers/app.mjs";
import { agentOwner, loadAgentModules, makeKey, mcp } from "./helpers/agents.mjs";
import { createDraft, act } from "./helpers/sending.mjs";
import * as cloudflare from "./stubs/cloudflare-api.mjs";
import { published } from "./stubs/qstash.mjs";
import { txts } from "./stubs/dns-check.mjs";

let app, m, owner, other;
before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	Object.assign(m, {
		Message: (await import("../models/Message.js")).default,
		Domain: (await import("../models/Domain.js")).default,
		health: await import("../lib/newsletter-health.js"),
		plans: await import("../lib/plans.js"),
		rules: await import("../lib/newsletters.js"),
		volumes: (await import("../lib/campaign-queries.js")).getSendVolumes,
		sending: await import("../lib/sending.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
	});
	owner = await agentOwner(m, "fleet-owner@example.com");
	other = await agentOwner(m, "fleet-other@example.com");
});
after(async () => app?.stop());
const accountOf = (user) => m.Account.findById(user.accountId).lean();
const newsletterOf = (user, id = user.newsletterId) => m.Newsletter.findOne({ accountId: user.accountId, _id: id }).lean();
const api = (key, method, path, body) => callApi(method, `/api/v1${path}`, { key, body });

test("plan newsletter limits, a large admin override, downgrade preservation and self-hosted no limit", async () => {
	const paid = { subscriptionStatus: "active" };
	assert.deepEqual(m.plans.PLANS.map((plan) => m.rules.getNewsletterLimit({ ...paid, plan: plan.id })), [3, 5, 10, 25, 50]);
	assert.equal(m.rules.getNewsletterLimit({}), 1);
	assert.equal(m.rules.getNewsletterLimit({ limitOverrides: { newsletters: 100 } }), 100);
	assert.equal(await withEnv({ FLOCKSTACK_CLOUD: "" }, () => m.rules.getNewsletterLimit({})), null);
	await m.Account.updateOne({ _id: owner.accountId }, { $set: { "limitOverrides.newsletters": 12 } });
	for (let index = 2; index < 12; index++) {
		const result = await api(owner.keys.full, "POST", "/newsletters", { name: `Fleet ${index}`, slug: `fleet-brand-${index}` });
		assert.equal(result.status, 201, JSON.stringify(result.body));
	}
	assert.equal((await api(owner.keys.full, "POST", "/newsletters", { name: "Over limit" })).status, 409);
	await m.Account.updateOne({ _id: owner.accountId }, { $unset: { "limitOverrides.newsletters": 1 } });
	assert.equal((await api(owner.keys.full, "GET", "/fleet")).body.newsletters.length, 12, "a downgrade keeps every newsletter");
});

test("fleet metrics stay within the account, report their sample and window, and agree over MCP", async () => {
	const sentAt = new Date(Date.now() - 3600_000);
	await m.Message.insertMany(Array.from({ length: 10 }, (_, index) => ({ accountId: owner.accountId, newsletterId: owner.newsletterId, kind: "campaign", email: `metric${index}@example.com`, status: "sent", sentAt, ...(index === 0 && { bouncedAt: sentAt }), ...(index === 1 && { complainedAt: sentAt }) })));
	await m.Message.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, kind: "test", email: "test@example.com", sentAt, bouncedAt: sentAt });
	await m.Message.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, kind: "campaign", email: "old@example.com", sentAt: new Date(Date.now() - 8 * 86_400_000), bouncedAt: sentAt });
	await addSentIssue(owner);
	const result = await api(owner.keys.read_only, "GET", "/fleet");
	assert.equal(result.status, 200, JSON.stringify(result.body));
	const first = result.body.newsletters.find((item) => item.id === owner.newsletterId);
	assert.deepEqual(first.health, { sent: 10, bounced: 1, complained: 1, bounceRate: 0.1, complaintRate: 0.1 });
	assert.equal(result.body.periodDays, 7);
	assert.ok(first.lastSentAt);
	assert.equal(result.body.newsletters.find((item) => item.id === owner.otherNewsletterId).health.bounceRate, null);
	assert.ok(!JSON.stringify(result.body).includes(other.slug));
	const called = await mcp(m, owner.keys.read_only, "tools/call", { name: "get_brand_fleet", arguments: {} });
	assert.equal(called.body.result.isError, undefined, JSON.stringify(called.body));
	assert.ok(JSON.stringify(called.body).includes('"sent":10'));
	const limited = await makeKey(m, owner, "full", { newsletter: owner.slug });
	assert.equal((await api(limited, "GET", "/fleet")).status, 403);
	assert.equal((await api(limited, "POST", "/fleet/domains", { domains: [{ domain: "example.com" }] })).status, 403);
	assert.equal((await api(owner.keys.drafts, "POST", "/fleet/domains", { domains: [{ domain: "example.com" }] })).status, 403);
});

test("automatic DNS is account-bound, preserves a stronger DMARC policy, and retries without duplicate records", async () => {
	const zoneId = "brand-zone";
	const config = { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_FLEET_ZONES: JSON.stringify([{ accountId: owner.accountId, domain: "fleet.example.com", zoneId }]) };
	await withEnv(config, async () => {
		const atStart = cloudflare.calls.length;
		const denied = await api(other.keys.full, "POST", "/fleet/domains", { domains: [{ domain: "fleet.example.com" }] });
		assert.equal(denied.status, 403);
		assert.equal(cloudflare.calls.length, atStart);
		await cloudflare.createDnsRecord(zoneId, { type: "TXT", name: "_dmarc.fleet.example.com", content: "v=DMARC1; p=reject;", ttl: 1 });
		const run = () => act(m, owner, "onboard_brand_domains", { domains: [{ domain: "fleet.example.com" }] });
		const first = await run();
		assert.equal(first.domains[0].state, "pending", JSON.stringify(first));
		assert.ok(first.domains[0].records.length >= 6);
		const records = cloudflare.listRecords(zoneId);
		assert.equal(records.find((record) => record.name === "_dmarc.fleet.example.com").content, "v=DMARC1; p=reject;");
		assert.ok(records.filter((record) => record.type === "CNAME").every((record) => record.proxied === false));
		const again = await run();
		assert.equal(again.domains[0].error, null, JSON.stringify(again));
		assert.equal(cloudflare.listRecords(zoneId).length, records.length);
		assert.ok(again.domains[0].records.every((record) => record.state === "existing"));
	});
});

test("a conflicting archive record is preserved and partial provider failures can be retried", async () => {
	const zoneId = "conflict-zone";
	await withEnv({ CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_FLEET_ZONES: JSON.stringify([{ accountId: owner.accountId, domain: "conflict.example.com", zoneId }]) }, async () => {
		await cloudflare.createDnsRecord(zoneId, { type: "A", name: "news.conflict.example.com", content: "192.0.2.1", ttl: 1 });
		const run = () => act(m, owner, "onboard_brand_domains", { domains: [{ domain: "conflict.example.com" }] });
		const conflict = (await run()).domains[0];
		assert.equal(conflict.state, "error");
		assert.match(conflict.error, /existing record/);
		assert.equal(cloudflare.listRecords(zoneId).length, 1, "preflight found the conflict before creating any DNS");
		await cloudflare.deleteDnsRecord(zoneId, cloudflare.listRecords(zoneId)[0].id);
		cloudflare.failNext({ name: "createDnsRecord", error: cloudflare.cloudflareError(503) });
		assert.equal((await run()).domains[0].state, "error");
		assert.equal((await run()).domains[0].error, null);
	});
});

test("a newsletter brake stops its campaigns and queued signup emails while a sibling keeps sending", async () => {
	const user = await agentOwner(m, "fleet-health@example.com");
	const now = new Date();
	await m.Message.insertMany(Array.from({ length: 100 }, (_, index) => ({ accountId: user.accountId, newsletterId: user.newsletterId, kind: "campaign", email: `brake${index}@example.com`, status: "sent", sentAt: now, ...(index < 5 && { bouncedAt: now }) })));
	const id = await createDraft(m, user);
	await m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { status: "sending" } });
	const status = await m.health.checkNewsletterHealth(user.accountId, (await newsletterOf(user))._id);
	assert.ok(status.problem);
	await assert.rejects(act(m, user, "send_test_email", { id, to: ["owner-test@example.com"] }), (error) => error.code === "newsletter_paused");
	assert.equal((await accountOf(user)).status, "active", "the local brake doesn't block the account");
	assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "paused");
	await m.Newsletter.updateMany({ accountId: user.accountId }, { $set: { requireConfirmation: true } });
	const contacts = await m.Contact.insertMany([user.newsletterId, user.otherNewsletterId].map((newsletterId, index) => ({ accountId: user.accountId, newsletterId, email: `queued${index}@example.com`, status: "pending" })));
	const queued = await m.Message.insertMany(contacts.map((contact) => ({ accountId: user.accountId, newsletterId: contact.newsletterId, contactId: contact._id, kind: "confirmation", email: contact.email, status: "queued" })));
	// Both would otherwise be eligible; the paused newsletter's message must never be claimed for delivery.
	await m.sending.sendMessageBatch({ accountId: user.accountId, messageIds: queued.map((item) => item._id) });
	assert.equal((await m.Message.findOne({ accountId: user.accountId, _id: queued[0]._id }).lean()).status, "queued");
	assert.equal((await m.Message.findOne({ accountId: user.accountId, _id: queued[1]._id }).lean()).status, "sent");
	await assert.rejects(act(m, user, "resume_newsletter_sending", { id: user.newsletterId }), /still over/);
	const gated = await api(user.keys.send_with_approval, "POST", `/newsletters/${user.newsletterId}/resume-sending`, {});
	assert.equal(gated.status, 202);
	await m.Message.updateMany({ accountId: user.accountId, newsletterId: user.newsletterId, sentAt: { $ne: null } }, { $set: { sentAt: new Date(Date.now() - 8 * 86_400_000) } });
	assert.deepEqual(await act(m, user, "resume_newsletter_sending", { id: user.newsletterId }), { resumed: true });
	assert.equal((await newsletterOf(user)).sendingBrake?.at, undefined);
	await assert.rejects(act(m, other, "resume_newsletter_sending", { id: user.newsletterId }), /not found/);
});

test("a new brand's warm-up cannot borrow another brand's proven volume, and changing sender domain resets proof", async () => {
	const user = await agentOwner(m, "fleet-warmup@example.com");
	await proveVolume(user, 10_000);
	const account = await accountOf(user);
	assert.equal((await m.volumes(account)).proven, 10_000);
	assert.equal((await m.volumes(account, new Date(), await newsletterOf(user, user.otherNewsletterId))).proven, 0);
	await addVerifiedDomain(user, "newbrand.example.com");
	await act(m, user, "update_newsletter", { id: user.newsletterId, fromEmail: "hello@newbrand.example.com" });
	const changed = await newsletterOf(user);
	assert.ok(changed.senderChangedAt);
	assert.equal(changed.spreadUntil, undefined);
	assert.equal((await m.volumes(account, new Date(), changed)).proven, 0);
	await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Old domain finishing late", status: "sent", stats: { sent: 20_000 }, startedAt: new Date(Date.now() - 86_400_000), sentAt: new Date(Date.now() - 3600_000), finishedAt: new Date() });
	assert.equal((await m.volumes(account, new Date(), changed)).proven, 0, "an old sender's campaign finishing later proves no volume for the new domain");
});

test("sibling recommendations are live only with the normal reader opt-in and never enqueue mail on creation", async () => {
	const user = await agentOwner(m, "fleet-recommend@example.com");
	await addSentIssue(user);
	await addSentIssue({ ...user, newsletterId: user.otherNewsletterId });
	for (const id of [user.newsletterId, user.otherNewsletterId]) await m.Newsletter.updateOne({ accountId: user.accountId, _id: id }, { $set: { archiveEnabled: true, requireConfirmation: true, "sharedSender.domain": `${id === user.newsletterId ? user.slug : user.otherSlug}.flockstackmail.com`, "sharedSender.provider": "ses", "sharedSender.verified": true } });
	const before = published.length;
	const added = await act(m, user, "add_recommendation", { newsletter: user.slug, slug: user.otherSlug, pitch: "More notes from this brand." });
	assert.equal(added.status, "active");
	assert.equal(published.length, before);
	const lib = await import("../lib/recommendations.js");
	assert.equal((await lib.listLiveRecommendations(await newsletterOf(user))).length, 1);
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId }), 0);
	const source = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "brandreader@example.org", status: "active" });
	const step = await lib.getReaderStep({ newsletter: await newsletterOf(user), contact: source });
	assert.equal((await lib.subscribeToRecommended({ token: step.token, slugs: [] })).error, "Tick the newsletters you want first.");
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, newsletterId: user.otherNewsletterId }), 0);
	const chosen = await lib.subscribeToRecommended({ token: step.token, slugs: [user.otherSlug] });
	assert.equal(chosen.results.length, 1);
	assert.equal(chosen.results[0].contact.status, "pending");
	assert.equal(chosen.results[0].contact.source, `recommendation:${user.slug}`);
});


test("automatic DNS keeps an inherited DMARC policy instead of weakening it with a new child policy", async () => {
	txts.set("_dmarc.example.org", [["v=DMARC1; p=reject;"]]);
	await withEnv({ CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_FLEET_ZONES: JSON.stringify([{ accountId: owner.accountId, domain: "policy.example.org", zoneId: "inherited-zone" }]) }, async () => {
		const result = await act(m, owner, "onboard_brand_domains", { domains: [{ domain: "policy.example.org" }] });
		assert.equal(result.domains[0].error, null);
		assert.ok(result.domains[0].records.some((record) => record.name === "_dmarc.example.org" && record.state === "existing"));
		assert.ok(!cloudflare.listRecords("inherited-zone").some((record) => record.name === "_dmarc.policy.example.org"));
	});
});

test("the fleet dashboard renders the account's brands and keeps another account out", async () => {
	const { renderToStaticMarkup } = await import("react-dom/server");
	const page = await import("../app/(app)/fleet/page.js");
	const html = renderToStaticMarkup(await as(owner, () => page.default()));
	assert.match(html, /Brand fleet/);
	assert.match(html, /fleet-owner one/);
	assert.match(html, /10\.00%/);
	assert.match(html, /No sent issue/);
	assert.ok(!html.includes("fleet-other one"));
});


test("bulk setup rejects an out-of-domain archive host before provisioning, even when it is a trusted server host", async () => {
	await withEnv({ CLOUDFLARE_API_TOKEN: "test-token", ARCHIVE_TRUSTED_HOSTS: "outside.example.org", CLOUDFLARE_FLEET_ZONES: JSON.stringify([{ accountId: owner.accountId, domain: "archive-bound.example.com", zoneId: "archive-zone" }]) }, async () => {
		const count = cloudflare.calls.length;
		await assert.rejects(act(m, owner, "onboard_brand_domains", { domains: [{ domain: "archive-bound.example.com", archiveHost: "outside.example.org" }] }), /within the approved brand domain/);
		assert.equal(cloudflare.calls.length, count);
		assert.equal(await m.Domain.countDocuments({ accountId: owner.accountId, domain: "archive-bound.example.com" }), 0);
	});
});
