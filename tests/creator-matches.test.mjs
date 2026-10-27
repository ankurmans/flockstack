import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { as, callApi, form, platformEmails, startTestApp, withEnv } from "./helpers/app.mjs";
import { createPublisher, importModels } from "./helpers/community.mjs";

let app, m, sequence = 0;
before(async () => {
	app = await startTestApp();
	m = { ...await importModels(), CreatorConversation: (await import("../models/CreatorConversation.js")).default, CreatorMessage: (await import("../models/CreatorMessage.js")).default, Recommendation: (await import("../models/Recommendation.js")).default, Account: (await import("../models/Account.js")).default, helpers: await import("../lib/creator-matches.js"), purge: await import("../lib/account-purge.js"), AgentActivity: (await import("../models/AgentActivity.js")).default };
});
after(async () => app?.stop());
const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, ...(body && { body }) });
const profile = (user, body) => api(user, "PATCH", "/creator-matches/settings", { newsletter: user.slug, ...body });
const matches = (user) => api(user, "GET", `/creator-matches?newsletter=${user.slug}`);
const inbox = (user) => api(user, "GET", `/creator-conversations?newsletter=${user.slug}`);
const intro = (from, to, externalId = `intro-${++sequence}`, body = "Would you like to discuss a recommendation swap?") => api(from, "POST", "/creator-conversations", { newsletter: from.slug, to: to.newsletterId, externalId, body });
async function creator(topics = ["gardening"], notifications = false) {
	const user = await createPublisher(m, `creator-${++sequence}@example.com`, { newsletter: { requireConfirmation: "on" } });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "sharedSender.domain": `${user.slug}.flockstackmail.com`, "sharedSender.provider": "ses", "sharedSender.verified": true } });
	assert.equal((await api(user, "PATCH", "/recommendations/settings", { newsletter: user.slug, listed: true })).status, 200);
	const saved = await profile(user, { enabled: true, topics, emailNotifications: notifications });
	assert.equal(saved.status, 200, JSON.stringify(saved.body));
	return user;
}

test("matching needs explicit listing and consent, ranks shared topics and shows ranges and only owned recommendation counts", async () => {
	const source = await creator(["Gardening", "food", "gardening"]);
	const near = await creator(["gardening", "food"]);
	const far = await creator(["software"]);
	const hidden = await creator(); await profile(hidden, { enabled: false });
	await m.Recommendation.create({ accountId: source.accountId, recommenderId: source.newsletterId, recommendedId: near.newsletterId, recommendedAccountId: near.accountId, pitch: "Good read.", stats: { impressions: 12, signups: 3, confirmed: 2 } });
	await m.Recommendation.create({ accountId: far.accountId, recommenderId: far.newsletterId, recommendedId: near.newsletterId, recommendedAccountId: near.accountId, pitch: "Other read.", stats: { impressions: 9999, signups: 999, confirmed: 99 } });
	const found = await matches(source); assert.equal(found.status, 200, JSON.stringify(found.body));
	const ownNear = found.body.matches.find((item) => item.id === near.newsletterId);
	const ownFar = found.body.matches.find((item) => item.id === far.newsletterId);
	assert.ok(ownNear.score > ownFar.score); assert.equal(ownNear.subscriberRange, "Under 100");
	assert.equal(ownNear.score, 27, "two shared topics, language, range and two owned confirmed signups");
	assert.deepEqual(ownNear.recommendation, { status: "active", impressions: 12, signups: 3, confirmed: 2 });
	assert.ok(found.body.matches.every((item) => ![source.newsletterId, hidden.newsletterId].includes(item.id)));
	assert.ok(!JSON.stringify(found.body).includes(near.accountId)); assert.ok(!JSON.stringify(found.body).includes("@"));
	assert.equal((await profile(source, { topics: ["contact@example.com"] })).status, 400);
	await api(source, "PATCH", "/recommendations/settings", { newsletter: source.slug, listed: false });
	assert.equal((await profile(source, { enabled: true })).status, 400);
	assert.equal((await matches(source)).body.enabled, false);
});

test("one transactional pair of private message copies survives concurrent retries without exposing account addresses", async () => {
	const from = await creator(), to = await creator();
	const startEmails = platformEmails.length;
	const results = await Promise.all([intro(from, to, "same-message"), intro(from, to, "same-message")]);
	for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
	assert.deepEqual(results[0].body, results[1].body);
	assert.equal(platformEmails.length, startEmails, "notifications off by default");
	const theirs = await inbox(to); assert.equal(theirs.body.conversations.length, 1);
	const mine = await api(from, "GET", `/creator-conversations/${results[0].body.conversationId}`);
	const other = await api(to, "GET", `/creator-conversations/${theirs.body.conversations[0].id}`);
	assert.equal(mine.body.messages.length, 1); assert.equal(other.body.messages.length, 1);
	assert.equal(mine.body.messages[0].direction, "outgoing"); assert.equal(other.body.messages[0].direction, "incoming");
	assert.equal((await api(to, "GET", `/creator-conversations/${results[0].body.conversationId}`)).status, 404);
	assert.equal((await intro(from, to, "same-message", "Changed words.")).status, 409);
	assert.ok(!JSON.stringify(other.body).includes(from.accountId)); assert.ok(!JSON.stringify(other.body).includes("@example.com"));
	await m.CreatorConversation.updateOne({ accountId: from.accountId, _id: results[0].body.conversationId }, { $unset: { lastMessageAt: 1 } });
	assert.equal((await intro(from, to, "same-message")).status, 200);
	assert.equal((await inbox(from)).body.conversations.length, 1, "retry repairs a request interrupted before inbox ordering");
	assert.ok(m.purge.CONTENT_MODELS.includes(m.CreatorMessage)); assert.ok(m.purge.CONTENT_MODELS.includes(m.CreatorConversation));
});

test("a recipient duplicate rolls back both-copy insertion rather than leaving a sender-only success", async () => {
	const from = await creator(), to = await creator();
	const conversation = await m.CreatorConversation.create({ accountId: to.accountId, newsletterId: to.newsletterId, otherNewsletterId: from.newsletterId, otherName: "A creator" });
	const messageKey = createHash("sha256").update(`${from.newsletterId}:partial-fixture`).digest("hex");
	await m.CreatorMessage.create({ accountId: to.accountId, newsletterId: to.newsletterId, conversationId: conversation._id, messageKey, fromNewsletterId: from.newsletterId, toNewsletterId: to.newsletterId, fromName: "A creator", body: "Old fixture", direction: "incoming" });
	assert.equal((await intro(from, to, "partial-fixture")).status, 409);
	assert.equal(await m.CreatorMessage.countDocuments({ accountId: from.accountId, messageKey }), 0);
});

test("opt-out stops new introductions; existing replies continue until either account closes its conversation", async () => {
	const from = await creator(), to = await creator();
	const sent = await intro(from, to);
	const theirs = (await inbox(to)).body.conversations[0];
	await profile(to, { enabled: false });
	const stranger = await creator(); assert.equal((await intro(stranger, to)).status, 400);
	const reply = (externalId) => api(to, "POST", `/creator-conversations/${theirs.id}/messages`, { body: "Thanks for reaching out.", externalId });
	assert.equal((await reply("reply-one")).status, 200);
	assert.equal((await api(from, "PATCH", `/creator-conversations/${sent.body.conversationId}`, { closed: true })).status, 200);
	assert.equal((await reply("reply-two")).status, 400);
	await api(to, "PATCH", `/creator-conversations/${theirs.id}`, { closed: false });
	assert.equal((await reply("reply-two")).status, 400, "the recipient cannot reopen the sender's closed side");
	await api(from, "PATCH", `/creator-conversations/${sent.body.conversationId}`, { closed: false });
	assert.equal((await reply("reply-two")).status, 200);
	await m.Newsletter.deleteOne({ accountId: from.accountId, _id: from.newsletterId });
	assert.equal((await reply("reply-three")).status, 400);
	assert.equal((await api(to, "GET", `/creator-conversations/${theirs.id}`)).body.messages.length, 3, "recipient retains its own copy after the sender leaves");
});

test("email opt-in relays text with platform headers, one per thread per hour; no notification claim or message enters activity logs", async () => {
	const from = await creator(), to = await creator(["gardening"], true);
	const startEmails = platformEmails.length;
	const sent = await intro(from, to, "email-one", "Hello, would a gardening swap suit you?");
	assert.equal(sent.status, 200, JSON.stringify(sent.body));
	let emails = platformEmails.slice(startEmails); assert.equal(emails.length, 1);
	assert.ok(emails[0].text.includes("gardening swap")); assert.ok(emails[0].text.includes("/recommending/creators/"));
	assert.ok(!JSON.stringify({ ...emails[0], to: null }).includes(`${from.slug}@example.com`));
	assert.ok(!JSON.stringify({ ...emails[0], to: null }).includes(`${to.slug}@example.com`));
	assert.equal((await api(from, "POST", `/creator-conversations/${sent.body.conversationId}/messages`, { body: "A second private note.", externalId: "email-two" })).status, 200);
	assert.equal(platformEmails.length, startEmails + 1);
	const activity = await m.AgentActivity.find({ accountId: from.accountId }).lean(); assert.ok(!JSON.stringify(activity).includes("gardening swap"));
	await withEnv({ SENDING_ENABLED: "false" }, async () => assert.equal((await api(from, "POST", `/creator-conversations/${sent.body.conversationId}/messages`, { body: "Inbox works while emails are off.", externalId: "email-three" })).status, 200));
	assert.equal(platformEmails.length, startEmails + 1);
});

test("agent approval, draft restrictions and newsletter limits apply before any private message is sent", async () => {
	const from = await creator(), to = await creator();
	const key = async (fields) => (await as(from, () => m.apiKeys.createApiKey(null, form({ name: "Bounded agent", ...fields })))).key;
	const original = from.key; from.key = await key({ level: "drafts" });
	assert.equal((await intro(from, to)).status, 403);
	from.key = await key({ level: "send_with_approval" });
	const held = await intro(from, to); assert.equal(held.status, 202, JSON.stringify(held.body));
	assert.equal((await inbox(to)).body.conversations.length, 0);
	const other = await m.Newsletter.create({ accountId: from.accountId, name: "Other", slug: `other-${++sequence}`, fromEmail: "hello@example.com" });
	from.key = await key({ level: "full", newsletter: String(other._id) });
	assert.equal((await intro(from, to)).status, 403);
	from.key = original; const sent = await intro(from, to);
	from.key = await key({ level: "full", newsletter: String(other._id) });
	assert.equal((await api(from, "GET", `/creator-conversations/${sent.body.conversationId}`)).status, 403);
});

test("message paging keeps account copies isolated and body text is not interpreted as markup", async () => {
	const from = await creator(), to = await creator(); const sent = await intro(from, to, "paging-start", "<script>hello</script>");
	assert.equal(sent.status, 200);
	const row = await m.CreatorConversation.findOne({ accountId: from.accountId, _id: sent.body.conversationId }).lean();
	await m.CreatorMessage.insertMany(Array.from({ length: 55 }, (_, index) => ({ accountId: from.accountId, newsletterId: from.newsletterId, conversationId: row._id, messageKey: `paging-${index}`, fromNewsletterId: from.newsletterId, toNewsletterId: to.newsletterId, fromName: "A creator", body: `Message ${index}`, direction: "outgoing" })));
	const first = await api(from, "GET", `/creator-conversations/${row._id}`); assert.equal(first.body.messages.length, 50); assert.ok(first.body.before);
	const second = await api(from, "GET", `/creator-conversations/${row._id}?before=${first.body.before}`); assert.equal(second.body.messages.length, 6);
	assert.equal(second.body.messages[0].body, "<script>hello</script>");
	assert.equal((await api(to, "GET", `/creator-conversations/${row._id}`)).status, 404);
});

test("creator webhooks contain only scoped IDs, retries do not repeat them, and even ID-shaped bodies stay out of logs", async () => {
	const from = await creator(), to = await creator();
	for (const user of [from, to]) assert.equal((await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/creator-events", newsletter: user.newsletterId, events: ["creator_message.created"] })).status, 201);
	const body = "1234567890abcdef12345678";
	const first = await intro(from, to, "webhook-message", body); assert.equal(first.status, 200);
	assert.equal((await intro(from, to, "webhook-message", body)).status, 200);
	const Delivery = (await import("../models/WebhookDelivery.js")).default;
	for (const user of [from, to]) {
		const rows = await Delivery.find({ accountId: user.accountId, type: "creator_message.created" }).lean(); assert.equal(rows.length, 1);
		const data = JSON.parse(rows[0].payload).data; assert.equal(data.newsletterId, user.newsletterId);
		assert.deepEqual(Object.keys(data).sort(), ["id", "newsletterId", "parentId"]);
		assert.ok(!rows[0].payload.includes(body)); assert.ok(!rows[0].payload.includes("@example.com"));
	}
	const records = await m.AgentActivity.find({ accountId: from.accountId }).lean(); assert.ok(!JSON.stringify(records).includes(body));
});
