import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { as, callApi, form, startTestApp, withEnv } from "./helpers/app.mjs";
import { addReader, browser, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";
import { setAi } from "./stubs/opennext-cloudflare.mjs";
let app, m, counter = 0;
const TYPES = ["subscriber.deleted", "issue.published", "issue.updated", "comment.created", "comment.updated", "comment.deleted", "comment.moderated", "reply.received", "reply_rules.updated"];
before(async () => {
	app = await startTestApp();
	m = { ...(await importModels()), Comment: (await import("../models/Comment.js")).default, Delivery: (await import("../models/WebhookDelivery.js")).default, replies: await import("../lib/replies.js"), rules: await import("../app/(app)/comments/actions.js") };
});
afterEach(() => setAi(null));
after(() => app?.stop());
const api = (u, method, path, body) => callApi(method, `/api/v1${path}`, { key: u.key, body });
async function setup() {
	const user = await createPublisher(m, `reader-events${++counter}@example.com`);
	const endpoint = await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/events", newsletter: user.newsletterId, events: TYPES });
	assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
	return user;
}
async function events(user, type) {
	const rows = await m.Delivery.find({ accountId: user.accountId, ...(type && { type }) }).sort({ createdAt: 1, _id: 1 }).lean();
	return rows.map(row => JSON.parse(row.payload));
}
function privatePayload(event) {
	assert.deepEqual(Object.keys(event.data).sort(), event.data.parentId ? ["id", "newsletterId", "parentId"] : ["id", "newsletterId"]);
	assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|example\.com|reason|authorId|contactId|body|consent|confidence|session|rules"/);
}

test("web publication and published edits/restores emit identifiers separately from email completion", async () => {
	const user = await setup();
	const made = await api(user, "POST", "/campaigns", { newsletter: user.newsletterId, subject: "PRIVATE_SUBJECT", content: "PRIVATE_BODY", publishTo: "web" });
	assert.equal(made.status, 201, JSON.stringify(made.body)); const id = made.body.id;
	assert.equal((await events(user, "issue.published")).length, 0);
	assert.equal((await api(user, "POST", `/campaigns/${id}/send`, {})).status, 200);
	assert.equal((await api(user, "POST", `/campaigns/${id}/send`, {})).status, 409);
	assert.equal((await events(user, "issue.published")).length, 1);
	assert.equal((await api(user, "PATCH", `/campaigns/${id}/published`, { title: "PRIVATE_NEW_TITLE", content: "PRIVATE_NEW_BODY" })).status, 200);
	const versions = await api(user, "GET", `/campaigns/${id}/versions`);
	assert.equal(versions.status, 200); assert.ok(versions.body.versions.length);
	assert.equal((await api(user, "POST", `/campaigns/${id}/versions/${versions.body.versions[0].id}/restore`, {})).status, 200);
	assert.equal((await events(user, "issue.updated")).length, 2);
	assert.equal((await events(user, "campaign.sent")).length, 0);
	for (const event of await events(user)) { privatePayload(event); assert.equal(event.data.id, id); }
});

test("short posts publish, while email-only issues and resends never claim a new web publication", async () => {
	const user = await setup();
	const note = await api(user, "POST", "/campaigns", { newsletter: user.newsletterId, kind: "note", content: "PRIVATE_SHORT_POST" });
	assert.equal(note.status, 201, JSON.stringify(note.body));
	assert.equal((await api(user, "POST", `/campaigns/${note.body.id}/send`, {})).status, 200);
	assert.equal((await events(user, "issue.published")).length, 1);
	const { emitIssuePublished } = await import("../lib/issue-events.js");
	for (const extra of [{ publishTo: "email" }, { resend: { of: user.issue._id } }]) await emitIssuePublished({ accountId: user.accountId, newsletterId: user.newsletterId, _id: user.issue._id, ...extra }, user.newsletter);
	assert.equal((await events(user, "issue.published")).length, 1);
});

test("reader comment lifecycle events carry no authored text and repeated human decisions do not emit again", async () => {
	const user = await setup(), reader = await addReader(m, user, "private-reader@example.com"), visitor = await signInReader(m, user, reader);
	const submit = fields => inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, ...fields })));
	const root = await submit({ body: "PRIVATE_COMMENT_BODY" }); assert.equal(root.ok, true);
	assert.equal((await submit({ body: "PRIVATE_COMMENT_BODY" })).code, "duplicate");
	const reply = await submit({ body: "PRIVATE_COMMENT_REPLY", parent: root.id }); assert.equal(reply.ok, true);
	const edit = await inBrowser(visitor, () => m.commentActions.submitEdit(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: root.id, body: "PRIVATE_CHANGED_BODY" })));
	assert.equal(edit.ok, true);
	for (const [action, reason] of [["hide", "PRIVATE_REASON"], ["hide", "PRIVATE_REASON"], ["hide", "PRIVATE_CHANGED_REASON"], ["approve", undefined]]) {
		assert.equal((await api(user, "POST", `/comments/${root.id}/moderate`, { action, ...(reason && { reason }) })).status, 200);
	}
	assert.equal((await events(user, "comment.moderated")).length, 3);
	assert.equal((await events(user, "comment.created")).length, 2);
	assert.equal((await events(user, "comment.updated")).length, 1);
	const deleted = await inBrowser(visitor, () => m.commentActions.submitDelete(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: root.id })));
	assert.equal(deleted.ok, true); assert.equal((await events(user, "comment.deleted")).length, 1);
	assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: root.id }).lean()).body, "");
	for (const event of await events(user)) privatePayload(event);
});

test("contact deletion emits one ID-only reference and cannot expose the deleted address", async () => {
	const user = await setup(), reader = await addReader(m, user, "deleted-private@example.com");
	assert.equal((await api(user, "DELETE", `/contacts/${reader._id}`)).status, 200);
	assert.equal((await api(user, "DELETE", `/contacts/${reader._id}`)).status, 404);
	const list = await events(user, "subscriber.deleted"); assert.equal(list.length, 1); assert.equal(list[0].data.id, String(reader._id)); privatePayload(list[0]);
});

test("concurrent repeated incoming replies store and emit one reference, never email or reply text", async () => {
	await withEnv({ REPLIES_DOMAIN: "reply.example.com" }, async () => {
		const user = await setup(), contact = await addReader(m, user, "reply-private@example.com");
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { replyInbox: true } });
		const message = await m.Message.create({ accountId: user.accountId, newsletterId: user.newsletterId, campaignId: user.issue._id, contactId: contact._id, kind: "campaign", status: "sent", email: contact.email });
		const { getReplyAddress } = await import("../lib/reply-address.js");
		const input = { to: getReplyAddress(message), from: contact.email, subject: "PRIVATE_SUBJECT", text: "PRIVATE_INCOMING_BODY", externalId: "same-message" };
		await Promise.all(Array.from({ length: 4 }, () => m.replies.ingestReply(input)));
		const list = await events(user, "reply.received"); assert.equal(list.length, 1); assert.equal(list[0].data.parentId, String(user.issue._id)); privatePayload(list[0]);
	});
});

test("owner rules configuration emits only its newsletter reference", async () => {
	const user = await setup(); setAi({ async run() { throw new Error("No inference expected"); } });
	assert.equal((await as(user, () => m.rules.saveReplyRules({ newsletter: user.newsletterId, enabled: true, rules: ["PRIVATE_WRITTEN_RULE"], learnFromHides: true, consent: true }))).ok, true);
	const list = await events(user, "reply_rules.updated"); assert.equal(list.length, 1); privatePayload(list[0]);
});

test("connector deduplication keeps distinct same-millisecond events and repeats the same event identity", async () => {
	const { createRequire } = await import("node:module");
	const { flatten } = createRequire(import.meta.url)("../integrations/zapier/triggers/event.js");
	const event = { id: "msg_first", type: "comment.updated", timestamp: "2026-10-25T12:00:00.000Z", data: { id: "comment-id", newsletterId: "newsletter-id" } };
	assert.equal(flatten(event).id, flatten(structuredClone(event)).id);
	assert.notEqual(flatten(event).id, flatten({ ...event, id: "msg_second" }).id);
	assert.equal(flatten(event).objectId, "comment-id");
});
