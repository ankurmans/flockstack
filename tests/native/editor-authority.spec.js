import { env } from "cloudflare:workers";
import * as Y from "yjs";
import { it, expect } from "vitest";
import { createCollaborationTicket } from "../../lib/collaboration-ticket.js";
it("the actual compiled API authority validates a signed human ticket against native D1 and rejects session revocation", async () => {
	await env.TEST_DB.exec(env.EDITOR_TEST_SCHEMA);
	const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24), sessionId = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	for (const [table, key, data] of [["c_users", id, { name: "Native editor", email: "native-editor@example.com", emailVerified: true }], ["c_sessions", sessionId, { userId: id, expiresAt: new Date(Date.now() + 3600000).toISOString(), token: "synthetic-session-token" }], ["c_accounts", id, { ownerId: id }], ["c_campaigns", id, { newsletterId: id, kind: "issue", status: "draft", format: "rich", subject: "Native authority", previewText: "", html: "<p>Current draft</p>", markdown: "" }]]) {
		await env.TEST_DB.prepare(`INSERT INTO ${table} (_id, accountId, data) VALUES (?, ?, ?)`).bind(key, id, JSON.stringify({ _id: key, accountId: id, ...data })).run();
	}
	const reference = { accountId: id, campaignId: id, userId: id, sessionId }, ticket = createCollaborationTicket(reference);
	const current = await env.REAL_AUTHORITY.inspectTicket(ticket); expect(current.role).toBe("owner"); expect(current.name).toBe("Native editor"); expect(current.campaign.html).toBe("<p>Current draft</p>"); expect(JSON.stringify(current)).not.toContain("synthetic-session-token");
	const doc = new Y.Doc(), paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText(); text.insert(0, "Native body"); paragraph.insert(0, [text]); doc.getXmlFragment("default").insert(0, [paragraph]); doc.getText("subject").insert(0, "Canonical live subject "); doc.getText("previewText").insert(0, "Native preview ");
	const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), epoch = crypto.randomUUID();
	const saved = await env.REAL_AUTHORITY.checkpoint(reference, { expectedHash: current.fingerprint, epoch, state, subject: "Canonical live subject ", previewText: "Native preview ", html: "<p>Native body</p>" });
	expect(saved.fingerprint).not.toBe(current.fingerprint);
	expect((await env.REAL_AUTHORITY.authorize(reference)).fingerprint).toBe(saved.fingerprint);
	const row = await env.TEST_DB.prepare("SELECT data FROM c_campaigncollaborations WHERE accountId=?").bind(id).first(); expect(JSON.parse(row.data).state).toBe(state);
	const campaign = await env.TEST_DB.prepare("SELECT data FROM c_campaigns WHERE _id=?").bind(id).first(); expect(JSON.parse(campaign.data).subject).toBe("Canonical live subject");

	await env.TEST_DB.prepare("DELETE FROM c_sessions WHERE _id=?").bind(sessionId).run(); expect(await env.REAL_AUTHORITY.authorize(reference)).toEqual({ allowed: false });
});
