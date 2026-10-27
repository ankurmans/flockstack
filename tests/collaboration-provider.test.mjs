import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as Y from "yjs";
import { CampaignCollaborationProvider } from "../lib/collaboration-provider.js";
import { newDocument, stateBase64 } from "../workers/collaboration/document.js";
const original = globalThis.WebSocket, providers = [];
class Socket extends EventTarget {
	static OPEN = 1;
	constructor() { super(); this.readyState = 1; this.frames = []; }
	send(frame) { this.frames.push(JSON.parse(frame)); }
	close() { this.readyState = 3; }
}
before(() => { globalThis.WebSocket = Socket; });
after(() => { for (const provider of providers) provider.destroy(); globalThis.WebSocket = original; });
const b64 = value => Buffer.from(value).toString("base64");
async function connected() {
	const provider = new CampaignCollaborationProvider(async () => ({ url: "wss://example.com/api/collaboration/socket", ticket: "synthetic" })); providers.push(provider); await provider.connect();
	const server = newDocument({ subject: "Shared subject", html: "<p>Body</p>" }), ready = { type: "ready", state: stateBase64(server), vector: b64(Y.encodeStateVector(server)), epoch: "fa1cf993-4a61-4284-81dd-ae32c1c215bd", clientId: 12345, user: { name: "Writer", color: "#38761d" }, role: "editor" };
	provider.receive(ready); return { provider, server, ready };
}
test("client shared text emits minimal CRDT edits and a durable flush can confirm a lost acknowledgement", async () => {
	const { provider } = await connected(); provider.replaceText("subject", "Shared subject updated"); provider.sendPending(); assert.equal(provider.dirty, true);
	const update = provider.socket.frames.findLast(frame => frame.type === "update"); assert.ok(update); assert.equal(update.sequence, 1);
	const flush = provider.flush(), marker = provider.socket.frames.findLast(frame => frame.type === "flush"); provider.receive({ type: "flushed", requestId: marker.requestId });
	assert.equal(await flush, true); assert.equal(provider.dirty, false); assert.equal(provider.status, "saved");
});
test("reconnect derives unacknowledged changes from state vectors and preserves another writer's edits", async () => {
	const { provider, server, ready } = await connected(); provider.replaceText("subject", "Offline subject"); provider.sendPending();
	server.getXmlFragment("default").get(0).get(0).insert(0, "Other writer ");
	await provider.connect(); provider.receive({ ...ready, clientId: 23456, state: stateBase64(server), vector: b64(Y.encodeStateVector(server)) });
	const retry = provider.socket.frames.findLast(frame => frame.type === "update"); assert.ok(retry); Y.applyUpdate(server, Buffer.from(retry.update, "base64"));
	assert.equal(server.getText("subject").toString(), "Offline subject"); assert.match(server.getXmlFragment("default").toString(), /Other writer/);
	provider.receive({ type: "ack", sequence: retry.sequence, checkpointAt: new Date().toISOString() }); assert.equal(provider.dirty, false);
});
test("an outside-edit epoch mismatch keeps the local draft and refuses to flush over the newer document", async () => {
	const { provider, ready } = await connected(); provider.replaceText("subject", "Keep my local copy");
	provider.receive({ ...ready, epoch: "d8db9629-c655-43ee-8bf2-d68807c3a80c" }); assert.equal(provider.status, "conflict"); assert.equal(provider.doc.getText("subject").toString(), "Keep my local copy"); assert.equal(await provider.flush(), false);
});
test("a reconnect whose vector already contains an unknown accepted update clears the unsaved state", async () => {
	const { provider, server, ready } = await connected(); provider.replaceText("subject", "Accepted before disconnect"); provider.sendPending();
	Y.applyUpdate(server, Buffer.from(provider.socket.frames.findLast(frame => frame.type === "update").update, "base64"));
	await provider.connect(); provider.receive({ ...ready, clientId: 34567, state: stateBase64(server), vector: b64(Y.encodeStateVector(server)) }); assert.equal(provider.dirty, false); assert.equal(provider.status, "saved");
});
test("backpressure merges typing behind one update and flush includes the later pending change", async () => {
	const { provider } = await connected(); provider.replaceText("subject", "First change"); provider.sendPending(); provider.replaceText("subject", "Second change"); provider.sendPending();
	assert.equal(provider.socket.frames.filter(frame => frame.type === "update").length, 1);
	const flush = provider.flush(), firstMarker = provider.socket.frames.findLast(frame => frame.type === "flush"); provider.receive({ type: "flushed", requestId: firstMarker.requestId });
	await Promise.resolve(); assert.equal(provider.socket.frames.filter(frame => frame.type === "update").length, 2);
	const nextMarker = provider.socket.frames.findLast(frame => frame.type === "flush"); assert.notEqual(firstMarker.requestId, nextMarker.requestId); provider.receive({ type: "flushed", requestId: nextMarker.requestId }); assert.equal(await flush, true); assert.equal(provider.dirty, false);
});
test("leaving the mounted editor lets its pending save finish before closing the connection", async () => {
	const { provider } = await connected(); provider.replaceText("subject", "Save before leaving"); const disposed = provider.disposeAfterFlush(); assert.notEqual(provider.closed, true);
	const marker = provider.socket.frames.findLast(frame => frame.type === "flush"); provider.receive({ type: "flushed", requestId: marker.requestId }); await disposed; assert.equal(provider.closed, true);
});
test("a connection closing during flush leaves changes unconfirmed without an unhandled rejection", async () => {
	const { provider } = await connected(); provider.replaceText("subject", "Unconfirmed local copy"); provider.socket.send = () => { throw new Error("Connection closed"); }; assert.equal(await provider.flush(), false); assert.equal(provider.dirty, true); await provider.disposeAfterFlush(); assert.equal(provider.closed, true);
});
