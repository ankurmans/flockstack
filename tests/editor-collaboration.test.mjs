import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import mongoose from "../lib/docdb/index.js";
import { as, platformEmails, startTestApp } from "./helpers/app.mjs";
import { api, createSeller, installFakeStripe } from "./helpers/shop.mjs";
let app, fake, m, count = 0;
before(async () => {
	app = await startTestApp({ COLLABORATION_ENABLED: "true" }); fake = installFakeStripe();
	m = { Campaign: (await import("../models/Campaign.js")).default, Snapshot: (await import("../models/CampaignCollaboration.js")).default, Seat: (await import("../models/TeamSeat.js")).default, Thread: (await import("../models/EditorThread.js")).default, authority: await import("../lib/collaboration-authority.js"), tickets: await import("../lib/collaboration-ticket.js"), run: (await import("../lib/actions/run-action.js")).runAction, document: await import("../workers/collaboration/document.js"), connect: (await import("../app/(app)/campaigns/[id]/collaborate/actions.js")).connectCampaign };
});
after(() => app?.stop());
async function issue() {
	const user = await createSeller(`editor-owner${++count}@example.com`, { fake });
	const response = await api(user, "POST", "/campaigns", { newsletter: user.slug, subject: "Private draft", format: "rich", content: "<p>Selected editorial text</p>" }); assert.equal(response.status, 201);
	const id = response.body.id, connected = await as(user, () => m.connect(id)); assert.ok(connected.ticket, connected.error);
	const reference = m.tickets.readCollaborationTicket(connected.ticket);
	return { user, id, connected, reference };
}
async function checkpoint(s, fields = {}) {
	const current = await m.authority.currentCollaboration(s.reference), doc = m.document.newDocument(current.campaign), epoch = randomUUID();
	return { epoch, output: await m.run("checkpoint_campaign_collaboration", { account: current.account, user: current.user, via: "dashboard", input: { id: s.id, expectedHash: current.fingerprint, epoch, state: m.document.stateBase64(doc), ...m.document.documentContent(doc), ...fields } }) };
}
test("human-only tickets expire, use separate signing keys and cannot expose a creator API capability", async () => {
	const s = await issue(); assert.equal(s.reference.campaignId, s.id); assert.doesNotMatch(s.connected.url, /ticket|token|user/);
	const context = await m.authority.inspectCollaborationTicket(s.connected.ticket); assert.equal(context.role, "owner"); assert.equal(context.name, "Writer"); assert.doesNotMatch(JSON.stringify(context), /session_token|@example.com/);
	assert.equal(m.tickets.readCollaborationTicket(m.tickets.createCollaborationTicket(s.reference, Date.now() - 61000)), null);
	assert.equal(m.tickets.readCollaborationTicket(m.tickets.createCollaborationTicket(s.reference, Date.now() + 60000)), null);
	assert.equal(m.tickets.readCollaborationTicket(s.connected.ticket.slice(0, -1) + "!"), null);
	assert.equal((await api(s.user, "POST", `/campaigns/${s.id}/collaboration`, {})).status, 404);
});
test("checkpoint CAS and ordinary form preconditions refuse a draft overwritten outside the CRDT room", async () => {
	const s = await issue(), before = await api(s.user, "GET", `/campaigns/${s.id}`); assert.ok(before.body.contentHash);
	await checkpoint(s); assert.equal(await m.Snapshot.countDocuments({ accountId: s.user.accountId, campaignId: s.id }), 1);
	assert.equal((await api(s.user, "PATCH", `/campaigns/${s.id}`, { content: "<p>Outside API edit</p>", format: "rich" })).status, 200);
	const stale = await api(s.user, "PATCH", `/campaigns/${s.id}`, { expectedContentHash: before.body.contentHash, subject: "Old browser" }); assert.equal(stale.status, 409);
	const current = await m.authority.currentCollaboration(s.reference);
	await assert.rejects(checkpoint(s, { expectedHash: before.body.contentHash }), error => error.code === "conflict");
	assert.match(current.campaign.html, /Outside API edit/);
});
test("private anchored threads, replies and mentions are scoped, retry-safe and never sent to subscribers", async () => {
	const s = await issue(), { epoch } = await checkpoint(s), mailCount = platformEmails.length;
	const members = await api(s.user, "GET", `/campaigns/${s.id}/collaborators`); assert.equal(members.status, 200); assert.doesNotMatch(JSON.stringify(members.body), /@example.com/);
	const externalId = randomUUID(), input = { externalId, epoch, body: "Private editorial comment", mentions: [String(s.user.userId)], anchor: { start: "synthetic-relative-start", end: "synthetic-relative-end", quote: "Selected editorial text" } };
	const added = await api(s.user, "POST", `/campaigns/${s.id}/editor-threads`, input); assert.equal(added.status, 200); assert.equal(added.body.thread.authorName, "Agent");
	const retry = await api(s.user, "POST", `/campaigns/${s.id}/editor-threads`, input); assert.equal(retry.body.thread.id, added.body.thread.id);
	assert.equal((await api(s.user, "POST", `/campaigns/${s.id}/editor-threads`, { ...input, body: "Different request" })).status, 409);
	const threadId = added.body.thread.id, replyId = randomUUID();
	assert.equal((await api(s.user, "POST", `/editor-threads/${threadId}/replies`, { externalId: replyId, body: "Private reply", mentions: [] })).status, 200);
	assert.equal((await api(s.user, "POST", `/editor-threads/${threadId}/replies`, { externalId: replyId, body: "Private reply", mentions: [] })).status, 200);
	const listed = await api(s.user, "GET", `/campaigns/${s.id}/editor-threads`); assert.equal(listed.body.threads[0].replies.length, 1);
	assert.equal((await api(s.user, "PATCH", `/editor-threads/${threadId}/resolution`, { resolved: true })).status, 200);
	const other = await issue(); assert.equal((await api(other.user, "GET", `/campaigns/${s.id}/editor-threads`)).status, 404);
	assert.equal((await api(s.user, "POST", `/campaigns/${s.id}/editor-threads`, { ...input, externalId: randomUUID(), mentions: [String(other.user.userId)] })).status, 400);
	assert.equal(platformEmails.length, mailCount + 1, "only the second synthetic owner's sign-in sends an email");
	assert.equal((await api(s.user, "DELETE", `/editor-threads/${threadId}`)).status, 200);
	const removed = (await api(s.user, "GET", `/campaigns/${s.id}/editor-threads`)).body.threads[0]; assert.equal(removed.body, ""); assert.deepEqual(removed.replies, []);
	const campaign = await m.Campaign.findOne({ accountId: s.user.accountId, _id: s.id }).lean(); assert.doesNotMatch(campaign.html, /Private editorial comment|Private reply/);
});
test("every authority read observes session revocation, team role and current draft state", async () => {
	const s = await issue(), teammate = await issue();
	await m.Seat.create({ accountId: s.user.accountId, email: "editor-member@example.com", userId: String(teammate.user.userId), role: "viewer", status: "active" });
	const reference = { ...teammate.reference, accountId: String(s.user.accountId), campaignId: s.id };
	assert.equal((await m.authority.currentCollaboration(reference)).role, "viewer");
	const current = await m.authority.currentCollaboration(reference);
	await assert.rejects(m.run("create_editor_thread", { account: current.account, user: current.user, via: "dashboard", input: { id: s.id, epoch: randomUUID(), externalId: randomUUID(), body: "Viewer cannot write" } }), error => error.code === "forbidden");
	await m.Seat.updateOne({ accountId: s.user.accountId, userId: String(teammate.user.userId) }, { $set: { status: "revoked" } });
	await assert.rejects(m.authority.currentCollaboration(reference), error => error.code === "forbidden");
	await m.Campaign.updateOne({ accountId: s.user.accountId, _id: s.id }, { $set: { status: "scheduled" } }); await assert.rejects(m.authority.currentCollaboration(s.reference), error => error.code === "conflict");
	await mongoose.connection.db.collection("sessions").deleteOne({ _id: new mongoose.Types.ObjectId(teammate.reference.sessionId) }); await assert.rejects(m.authority.currentCollaboration(teammate.reference), error => error.code === "forbidden");
});
test("idle snapshot cleanup rechecks checkpoint age and leaves a newly refreshed document intact", async () => {
	const s = await issue(); await checkpoint(s);
	const { setCollaborationStorage } = await import("./stubs/opennext-cloudflare.mjs"), { expireCollaborationSnapshots } = await import("../lib/editor-housekeeping.js");
	const old = new Date(Date.now() - 31 * 86400000); await m.Snapshot.updateOne({ accountId: s.user.accountId, campaignId: s.id }, { $set: { checkpointAt: old } });
	let calls = 0; setCollaborationStorage({ async purgeRooms(accountId, ids) { calls++; assert.equal(accountId, String(s.user.accountId)); assert.deepEqual(ids, [s.id]); await m.Snapshot.updateOne({ accountId: s.user.accountId, campaignId: s.id }, { $set: { checkpointAt: new Date() } }); } });
	try { assert.deepEqual(await expireCollaborationSnapshots(), { deleted: 0 }); assert.equal(calls, 1); assert.equal(await m.Snapshot.countDocuments({ accountId: s.user.accountId, campaignId: s.id }), 1);
		await m.Snapshot.updateOne({ accountId: s.user.accountId, campaignId: s.id }, { $set: { checkpointAt: old } }); setCollaborationStorage({ async purgeRooms() { calls++; } }); assert.deepEqual(await expireCollaborationSnapshots(), { deleted: 1 }); assert.equal(calls, 2);
	} finally { setCollaborationStorage(null); }
});
test("concurrent private comments cannot exceed the unique 100-thread slots and reads stay paginated", async () => {
	const s = await issue(), { epoch } = await checkpoint(s);
	for (let index = 1; index <= 99; index++) await m.Thread.create({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, campaignId: s.id, externalId: randomUUID(), slot: String(index), epoch, authorName: "Synthetic writer", body: `Private thread ${index}` });
	const results = await Promise.all([1, 2].map(index => api(s.user, "POST", `/campaigns/${s.id}/editor-threads`, { externalId: randomUUID(), epoch, body: `Concurrent thread ${index}` })));
	assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); assert.equal(await m.Thread.countDocuments({ accountId: s.user.accountId, campaignId: s.id }), 100);
	const first = await api(s.user, "GET", `/campaigns/${s.id}/editor-threads`); assert.equal(first.body.threads.length, 20); assert.ok(first.body.nextCursor);
	const next = await api(s.user, "GET", `/campaigns/${s.id}/editor-threads?cursor=${encodeURIComponent(first.body.nextCursor)}`); assert.equal(next.body.threads.length, 20); assert.equal(next.body.threads.some(thread => first.body.threads.some(row => row.id === thread.id)), false);
});
test("restoring identical words still invalidates the shared document's fingerprint and snapshot", async () => {
	const s = await issue(); await checkpoint(s); const before = await m.authority.currentCollaboration(s.reference);
	const { recordVersion } = await import("../lib/campaign-versions.js"), version = await recordVersion(before.account, before.campaign, { reason: "edit" }); assert.ok(version?._id);
	const restored = await api(s.user, "POST", `/campaigns/${s.id}/versions/${version._id}/restore`, {}); assert.equal(restored.status, 200);
	const after = await m.authority.inspectCollaboration(s.reference); assert.equal(after.campaign.html, before.campaign.html); assert.equal(after.campaign.subject, before.campaign.subject); assert.notEqual(after.fingerprint, before.fingerprint); assert.equal(after.snapshot, null);
});
test("legacy autosave callers keep their response while precondition-aware callers receive the next hash", async () => {
	const s = await issue(), { saveCampaign } = await import("../app/(app)/campaigns/actions.js"), values = { subject: "Saved normally", previewText: "", body: "<p>Saved body</p>", format: "rich" };
	assert.deepEqual(await as(s.user, () => saveCampaign(s.id, values)), { ok: true });
	const current = await api(s.user, "GET", `/campaigns/${s.id}`), output = await as(s.user, () => saveCampaign(s.id, { ...values, subject: "New content", expectedContentHash: current.body.contentHash })); assert.equal(output.ok, true); assert.match(output.contentHash, /^[a-f0-9]{64}$/); assert.notEqual(output.contentHash, current.body.contentHash);
	const stale = await as(s.user, () => saveCampaign(s.id, { ...values, expectedContentHash: current.body.contentHash })); assert.match(stale.error, /changed in another editor/);
});
