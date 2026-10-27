import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { documentContent, documentFromState } from "../../workers/collaboration/document-state.js";
import { default as worker } from "../../workers/collaboration/dist/index.js";
const b64 = value => Buffer.from(value).toString("base64");
function nextFrame(socket, type) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error(`No ${type} frame`)); }, 3000);
		function receive(event) { const data = JSON.parse(event.data); if (data.type !== type && data.type !== "error") return; clearTimeout(timeout); socket.removeEventListener("message", receive); resolve(data); }
		socket.addEventListener("message", receive);
	});
}
async function setup(role = "editor") {
	const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24), reference = { accountId: id, campaignId: id, userId: id, sessionId: id };
	await env.AUTHORITY.seed(reference, { subject: "Shared", previewText: "", html: "<p>Original</p>" }, role);
	const stub = env.ROOMS.getByName(`${id}/${id}`);
	return { reference, stub };
}
async function connect(s, reference = s.reference) {
	const response = await s.stub.fetch(new Request("https://example.com/api/collaboration/socket", { headers: { Upgrade: "websocket", "x-fs-editor-reference": JSON.stringify(reference) } }));
	expect(response.status).toBe(101);
	const socket = response.webSocket, readyPromise = nextFrame(socket, "ready"); socket.accept(); const ready = await readyPromise;
	const doc = documentFromState(ready.state); doc.clientID = ready.clientId;
	return { socket, ready, doc };
}
async function send(client, update, sequence = 1) {
	const ack = nextFrame(client.socket, "ack"); client.socket.send(JSON.stringify({ type: "update", update: b64(update), sequence })); return ack;
}
describe("native SQLite Durable Object collaborative editor", () => {
	it("merges simultaneous CRDT inserts from two clients and checkpoints their actual combined document", async () => {
		const s = await setup(), first = await connect(s), second = await connect(s);
		const vectorA = Y.encodeStateVector(first.doc), vectorB = Y.encodeStateVector(second.doc);
		first.doc.getText("subject").insert(0, "First "); second.doc.getText("subject").insert(0, "Second ");
		expect((await send(first, Y.encodeStateAsUpdate(first.doc, vectorA))).type).toBe("ack");
		expect((await send(second, Y.encodeStateAsUpdate(second.doc, vectorB))).type).toBe("ack");
		const current = await env.AUTHORITY.inspect(s.reference), merged = documentFromState(current.snapshot.state);
		expect(merged.getText("subject").toString()).toContain("First "); expect(merged.getText("subject").toString()).toContain("Second "); expect(merged.getText("subject").toString()).toContain("Shared");
		Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(merged)); Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(merged)); expect(first.doc.getText("subject").toString()).toBe(second.doc.getText("subject").toString());
		first.socket.close(); second.socket.close();
	});
	it("persists SQLite state across actual object eviction and reconnects with the same epoch", async () => {
		const s = await setup(), client = await connect(s), vector = Y.encodeStateVector(client.doc);
		client.doc.getText("previewText").insert(0, "Persisted through eviction"); expect((await send(client, Y.encodeStateAsUpdate(client.doc, vector))).type).toBe("ack");
		await runInDurableObject(s.stub, (_instance, state) => { expect(state.storage.sql.exec("SELECT state FROM room WHERE id=1").toArray()[0].state.length).toBeGreaterThan(0); });
		client.socket.close(); await evictDurableObject(s.stub);
		const reconnected = await connect(s); expect(reconnected.ready.epoch).toBe(client.ready.epoch); expect(documentContent(reconnected.doc).previewText).toBe("Persisted through eviction"); reconnected.socket.close();
	});
	it("rejects a viewer's edit and rechecks revoked sessions before accepting an update", async () => {
		const viewer = await setup("viewer"), read = await connect(viewer), vector = Y.encodeStateVector(read.doc);
		read.doc.getText("subject").insert(0, "Forbidden"); expect((await send(read, Y.encodeStateAsUpdate(read.doc, vector))).type).toBe("error"); expect((await env.AUTHORITY.inspect(viewer.reference)).campaign.subject).toBe("Shared");
		const s = await setup(), client = await connect(s), before = Y.encodeStateVector(client.doc); await env.AUTHORITY.revoke(s.reference.sessionId);
		client.doc.getText("subject").insert(0, "Revoked"); expect((await send(client, Y.encodeStateAsUpdate(client.doc, before))).type).toBe("error");
	});
	it("refuses stale writes after an outside edit and starts a new document epoch from canonical content", async () => {
		const s = await setup(), client = await connect(s), vector = Y.encodeStateVector(client.doc);
		await env.AUTHORITY.outside(s.reference, "<p>Outside edit wins</p>"); client.doc.getText("subject").insert(0, "Old "); expect((await send(client, Y.encodeStateAsUpdate(client.doc, vector))).type).toBe("error");
		const fresh = await connect(s); expect(fresh.ready.epoch).not.toBe(client.ready.epoch); expect(documentContent(fresh.doc).html).toContain("Outside edit wins"); fresh.socket.close();
	});
	it("refuses edits after a scheduled or sent transition and bounds untrusted document fields", async () => {
		const s = await setup(), client = await connect(s), vector = Y.encodeStateVector(client.doc); await env.AUTHORITY.lock(s.reference); client.doc.getText("subject").insert(0, "Late "); expect((await send(client, Y.encodeStateAsUpdate(client.doc, vector))).type).toBe("error");
		const other = await setup(), bad = await connect(other), before = Y.encodeStateVector(bad.doc); bad.doc.getText("unexpected").insert(0, "PRIVATE"); expect((await send(bad, Y.encodeStateAsUpdate(bad.doc, before))).type).toBe("error");
	});
	it("isolates account/campaign identities and purges private object state", async () => {
		const first = await setup(), second = await setup(), a = await connect(first), b = await connect(second), vector = Y.encodeStateVector(a.doc);
		a.doc.getText("subject").insert(0, "Only first "); await send(a, Y.encodeStateAsUpdate(a.doc, vector)); expect((await env.AUTHORITY.inspect(second.reference)).campaign.subject).toBe("Shared");
		await first.stub.purge(); await runInDurableObject(first.stub, (_instance, state) => { expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='room'").toArray()).toHaveLength(0); }); b.socket.close();
	});
	it("the public handshake rejects foreign origins, missing tickets and caller identity headers", async () => {
		const s = await setup();
		const request = (origin, protocol) => new Request("https://example.com/api/collaboration/socket", { headers: { upgrade: "websocket", origin, "sec-websocket-protocol": protocol, "x-fs-editor-reference": JSON.stringify(s.reference) } });
		expect((await worker.fetch(request("https://foreign.example.com", "flockstack-collaboration"), env)).status).toBe(403);
		expect((await worker.fetch(request("https://example.com", "flockstack-collaboration"), env)).status).toBe(403);
		const token = btoa(JSON.stringify(s.reference)); const response = await worker.fetch(request("https://example.com", `flockstack-collaboration, ticket.${token}`), env); expect(response.status).toBe(101); response.webSocket.accept(); response.webSocket.close();
	});
});
it("merges actual rich-text body edits and reconnects an offline client's unacknowledged changes", async () => {
	const s = await setup(), a = await connect(s), b = await connect(s), beforeA = Y.encodeStateVector(a.doc), beforeB = Y.encodeStateVector(b.doc);
	a.doc.getXmlFragment("default").get(0).get(0).insert(0, "First body "); b.doc.getXmlFragment("default").get(0).get(0).insert(0, "Second body ");
	await send(a, Y.encodeStateAsUpdate(a.doc, beforeA)); await send(b, Y.encodeStateAsUpdate(b.doc, beforeB));
	const saved = await env.AUTHORITY.inspect(s.reference), merged = documentFromState(saved.snapshot.state); expect(documentContent(merged).html).toContain("First body "); expect(documentContent(merged).html).toContain("Second body ");
	Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(merged)); a.socket.close();
	a.doc.getXmlFragment("default").get(0).get(0).insert(0, "Offline local ");
	const reconnected = await connect(s); Y.applyUpdate(reconnected.doc, Y.encodeStateAsUpdate(a.doc));
	await send(reconnected, Y.encodeStateAsUpdate(reconnected.doc, Uint8Array.from(atob(reconnected.ready.vector), char => char.charCodeAt(0))));
	const final = await env.AUTHORITY.inspect(s.reference); expect(final.campaign.html).toContain("Offline local "); expect(final.campaign.html).toContain("Second body ");
	reconnected.socket.close(); b.socket.close();
});
it("checks a revoked receiving session before broadcasting another writer's new text", async () => {
	const s = await setup(), a = await connect(s), receivingReference = { ...s.reference, sessionId: "revoked-reader-session" }, b = await connect(s, receivingReference);
	let receivedUpdates = 0; b.socket.addEventListener("message", event => { if (JSON.parse(event.data).type === "update") receivedUpdates++; });
	const closed = new Promise(resolve => b.socket.addEventListener("close", resolve, { once: true }));
	await env.AUTHORITY.revoke(receivingReference.sessionId);
	const vector = Y.encodeStateVector(a.doc); a.doc.getText("subject").insert(0, "Private new text "); await send(a, Y.encodeStateAsUpdate(a.doc, vector));
	const event = await closed; expect(event.code).toBe(4003); expect(receivedUpdates).toBe(0); a.socket.close();
});
it("uses a jurisdiction subnamespace before naming an EU object", async () => {
	const { roomNamespace } = await import("../../workers/collaboration/dist/index.js"); let called;
	const namespace = {}, original = { jurisdiction(value) { called = value; return namespace; } };
	expect(roomNamespace({ FLOCKSTACK_REGION: "eu", ROOMS: original })).toBe(namespace); expect(called).toBe("eu"); expect(roomNamespace({ FLOCKSTACK_REGION: "us", ROOMS: original })).toBe(original);
});
it("rejects a queued old-epoch connection after a fresh room opens on an outside edit", async () => {
	const s = await setup(), old = await connect(s), vector = Y.encodeStateVector(old.doc); old.doc.getText("subject").insert(0, "Stale queued words "); const update = b64(Y.encodeStateAsUpdate(old.doc, vector));
	await env.AUTHORITY.outside(s.reference, "<p>New canonical draft</p>"); const fresh = await connect(s); expect(fresh.ready.epoch).not.toBe(old.ready.epoch);
	const failed = nextFrame(fresh.socket, "error");
	await runInDurableObject(s.stub, async (instance, state) => { const socket = state.getWebSockets().find(peer => peer.deserializeAttachment()?.clientId === fresh.ready.clientId); const info = socket.deserializeAttachment(); socket.serializeAttachment({ ...info, epoch: old.ready.epoch }); await instance.webSocketMessage(socket, JSON.stringify({ type: "update", update, sequence: 1 })); });
	expect((await failed).type).toBe("error"); const current = await env.AUTHORITY.inspect(s.reference); expect(current.campaign.html).toBe("<p>New canonical draft</p>"); expect(current.campaign.subject).toBe("Shared");
});
