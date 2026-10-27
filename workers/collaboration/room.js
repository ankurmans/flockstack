import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { documentContent, documentFromState, newDocument, stateBase64 } from "./document.js";
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const b64 = value => Buffer.from(value).toString("base64");
const sameReference = (a, b) => a.accountId === b.accountId && a.campaignId === b.campaignId;
function deliver(socket, frame) { try { socket.send(frame); return true; } catch { try { socket.close(1011, "Reconnect to confirm your changes"); } catch {} return false; } }
const COLORS = ["#a23b72", "#1e6091", "#38761d", "#a64b00", "#674ea7"];
function awarenessUpdate(entries) {
	const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, entries.length);
	for (const entry of entries) { encoding.writeVarUint(encoder, entry.clientId); encoding.writeVarUint(encoder, entry.clock); encoding.writeVarString(encoder, JSON.stringify(entry.awareness ?? null)); }
	return b64(encoding.toUint8Array(encoder));
}
function safePosition(value) {
	if (!value || typeof value !== "object" || JSON.stringify(value).length > 500 || Object.keys(value).some(key => !["type", "tname", "item", "assoc"].includes(key))) return null;
	const id = part => part && Number.isSafeInteger(part.client) && part.client >= 0 && part.client <= 4294967295 && Number.isSafeInteger(part.clock) && part.clock >= 0;
	if (value.type !== undefined && !id(value.type) || value.item != null && !id(value.item) || value.tname !== undefined && value.tname !== "default" || value.assoc !== undefined && ![-1, 0, 1].includes(value.assoc) || !value.type && !value.tname) return null;
	try { return Y.relativePositionToJSON(Y.createRelativePositionFromJSON(value)); } catch { return null; }
}
export class CampaignRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env); this.queue = Promise.resolve(); this.waiting = 0;
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY, metadata TEXT NOT NULL, state TEXT NOT NULL)");
			const row = ctx.storage.sql.exec("SELECT metadata, state FROM room WHERE id=1").toArray()[0];
			if (row) { this.metadata = JSON.parse(row.metadata); this.doc = documentFromState(row.state); }
		});
	}
	enqueue(work) {
		if (this.waiting >= 40) return Promise.reject(new Error("The editor is busy. Reconnect to confirm your changes."));
		this.waiting++;
		const pending = this.queue.then(work); this.queue = pending.catch(() => {}).finally(() => { this.waiting--; }); return pending;
	}
	persist(doc, metadata) {
		const state = stateBase64(doc);
		if (state.length > 2800000) throw new Error("The collaborative document reached its state limit. Copy your changes and use the regular editor.");
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY, metadata TEXT NOT NULL, state TEXT NOT NULL)");
		this.ctx.storage.sql.exec("INSERT INTO room (id,metadata,state) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,state=excluded.state", JSON.stringify(metadata), state);
		this.doc?.destroy(); this.doc = doc; this.metadata = metadata;
	}
	async authorize(reference, writing = false) {
		const current = await this.env.AUTHORITY.authorize(reference);
		if (current.allowed === false || !this.metadata || !sameReference(reference, this.metadata.reference) || current.fingerprint !== this.metadata.fingerprint || writing && current.role === "viewer") throw new Error("This document or your editing access changed. Reload its current version.");
		return current;
	}
	async fetch(request) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
		let reference; try { reference = JSON.parse(request.headers.get("x-fs-editor-reference")); } catch { return new Response("Forbidden", { status: 403 }); }
		try { return await this.enqueue(async () => {
			const current = await this.env.AUTHORITY.inspect(reference);
			if (!this.metadata || current.fingerprint !== this.metadata.fingerprint) {
				for (const socket of this.ctx.getWebSockets()) { socket.serializeAttachment(null); socket.close(4009, "The draft changed outside this session"); }
				const doc = current.snapshot ? documentFromState(current.snapshot.state) : newDocument(current.campaign);
				this.persist(doc, { reference: { accountId: reference.accountId, campaignId: reference.campaignId }, fingerprint: current.fingerprint, epoch: current.snapshot?.epoch ?? crypto.randomUUID(), at: Date.now() });
			}
			if (!current.snapshot && current.role !== "viewer") {
				const doc = documentFromState(stateBase64(this.doc)), content = documentContent(doc);
				const saved = await this.env.AUTHORITY.checkpoint(reference, { ...content, state: stateBase64(doc), epoch: this.metadata.epoch, expectedHash: this.metadata.fingerprint });
				this.persist(doc, { ...this.metadata, fingerprint: saved.fingerprint });
			}
			if (!sameReference(reference, this.metadata.reference) || this.ctx.getWebSockets().length >= 20) return new Response("Editor unavailable", { status: 409 });
			const pair = new WebSocketPair(), [client, server] = Object.values(pair);
			let clientId; do { clientId = crypto.getRandomValues(new Uint32Array(1))[0]; } while (this.doc.store.clients.has(clientId) || this.ctx.getWebSockets().some(socket => socket.deserializeAttachment()?.clientId === clientId));
			const info = { reference: current.reference, epoch: this.metadata.epoch, clientId, clock: 0, awareness: { user: { name: current.name, color: COLORS[clientId % COLORS.length] } }, window: Date.now(), count: 0 };
			server.serializeAttachment(info); this.ctx.acceptWebSocket(server);
			deliver(server, JSON.stringify({ type: "ready", epoch: this.metadata.epoch, state: stateBase64(this.doc), vector: b64(Y.encodeStateVector(this.doc)), clientId, user: info.awareness.user, role: current.role }));
			await this.broadcastPresence(); await this.ctx.storage.setAlarm(Date.now() + 86400000);
			return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "flockstack-collaboration" } });
		}); } catch { return new Response("Editing access unavailable", { status: 403 }); }
	}
	async recipients() {
		const sockets = this.ctx.getWebSockets(), checks = await Promise.allSettled(sockets.map(async socket => { const info = socket.deserializeAttachment(); if (!info || info.epoch !== this.metadata?.epoch) throw new Error("The document epoch changed"); await this.authorize(info.reference); return [socket, info]; }));
		const result = [];
		for (const [index, check] of checks.entries()) { if (check.status === "fulfilled") result.push(check.value); else sockets[index].close(4003, "Your editing session or document changed"); }
		return result;
	}

	async broadcastPresence() {
		const peers = await this.recipients(), frame = JSON.stringify({ type: "awareness", update: awarenessUpdate(peers.map(([, info]) => info)) });
		for (const [socket] of peers) deliver(socket, frame);
	}
	async webSocketMessage(socket, raw) {
		try { await this.enqueue(async () => {
			if (typeof raw !== "string" || raw.length > 180000) throw new Error("The editor update is too large");
			const message = JSON.parse(raw), info = socket.deserializeAttachment();
			if (!info || info.epoch !== this.metadata?.epoch) throw new Error("Editing access is unavailable");
			if (Date.now() - info.window >= 1000) { info.window = Date.now(); info.count = 0; }
			if (++info.count > 60) throw new Error("Too many editor updates. Reconnect before continuing.");
			socket.serializeAttachment(info);
			const current = await this.authorize(info.reference, message.type === "update");
			if (message.type === "update") {
				if (typeof message.update !== "string" || message.update.length > 175000 || !Number.isSafeInteger(message.sequence) || message.sequence < 0) throw new Error("Invalid editor update");
				const update = bytes(message.update); if (update.byteLength > 128000) throw new Error("The editor update is too large");
				const next = documentFromState(stateBase64(this.doc)), before = Y.encodeStateVector(this.doc);
				Y.applyUpdate(next, update);
				if (next.share.size > 3 || [...next.share.keys()].some(key => !["subject", "previewText", "default"].includes(key))) throw new Error("Unsupported document fields");
				const content = documentContent(next), state = stateBase64(next);
				if (state.length > 2800000) throw new Error("The collaborative document is too large");
				const saved = await this.env.AUTHORITY.checkpoint(info.reference, { ...content, state, epoch: this.metadata.epoch, expectedHash: this.metadata.fingerprint });
				const change = b64(Y.encodeStateAsUpdate(next, before));
				this.persist(next, { ...this.metadata, fingerprint: saved.fingerprint, at: Date.now() });
				for (const [peer] of await this.recipients()) deliver(peer, JSON.stringify({ type: "update", update: change }));
				deliver(socket, JSON.stringify({ type: "ack", sequence: message.sequence, checkpointAt: saved.checkpointAt }));
			} else if (message.type === "awareness") {
				if (typeof message.update !== "string" || message.update.length > 4000) throw new Error("Invalid cursor update");
				const decoder = decoding.createDecoder(bytes(message.update));
				if (decoding.readVarUint(decoder) !== 1 || decoding.readVarUint(decoder) !== info.clientId) throw new Error("Invalid cursor identity");
				const clock = decoding.readVarUint(decoder), state = JSON.parse(decoding.readVarString(decoder));
				if (!Number.isSafeInteger(clock) || clock <= info.clock || clock > info.clock + 1000) return;
				info.clock = clock; info.awareness = state ? { user: { name: current.name, color: COLORS[info.clientId % COLORS.length] }, ...(state.cursor && safePosition(state.cursor.anchor) && safePosition(state.cursor.head) && { cursor: { anchor: safePosition(state.cursor.anchor), head: safePosition(state.cursor.head) } }) } : null;
				socket.serializeAttachment(info); await this.broadcastPresence();
			} else if (message.type === "flush" || message.type === "ping") {
				deliver(socket, JSON.stringify({ type: message.type === "flush" ? "flushed" : "pong", requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 64) : null, epoch: this.metadata.epoch }));
			} else throw new Error("Unknown editor message");
			await this.ctx.storage.setAlarm(Date.now() + 86400000);
		}); } catch (error) {
			try { deliver(socket, JSON.stringify({ type: "error", message: "The change could not be confirmed. Keep a copy and reopen the current draft.", detail: /too large|state limit|Too many editor/.test(error.message ?? "") ? error.message : null })); socket.close(4009, "Editing stopped; keep your local changes"); } catch {}
		}
	}
	async webSocketClose(socket) {
		await this.enqueue(async () => {
			const info = socket.deserializeAttachment();
			if (info) for (const [peer] of await this.recipients()) if (peer !== socket) deliver(peer, JSON.stringify({ type: "awareness", update: awarenessUpdate([{ ...info, clock: info.clock + 1, awareness: null }]) }));
		});
	}
	async webSocketError(socket) { socket.close(1011, "Reconnect to confirm your changes"); }
	async notifyEditorial() { return this.enqueue(async () => { for (const [socket] of await this.recipients()) deliver(socket, JSON.stringify({ type: "threads_changed" })); }); }
	async purge() {
		return this.enqueue(async () => { for (const socket of this.ctx.getWebSockets()) { socket.serializeAttachment(null); socket.close(4003, "This editing document was removed"); } await this.ctx.storage.deleteAll(); this.doc?.destroy(); this.doc = null; this.metadata = null; });
	}
	async alarm() { if (!this.metadata || Date.now() - this.metadata.at >= 86400000) await this.purge(); else await this.ctx.storage.setAlarm(this.metadata.at + 86400000); }
}
