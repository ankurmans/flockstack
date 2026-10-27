import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
function b64(value) { let text = ""; for (const byte of value) text += String.fromCharCode(byte); return btoa(text); }
export class CampaignCollaborationProvider {
	constructor(connect) {
		this.doc = new Y.Doc(); this.awareness = new Awareness(this.doc); this.awareness.setLocalState(null); this.connectAction = connect;
		this.listeners = new Set(); this.sequence = 0; this.ack = 0; this.pending = []; this.waiters = new Map(); this.status = "connecting";
		this.doc.on("update", (update, origin) => { if (origin === "server" || this.closed) return; this.pending.push(update); this.status = this.ready ? "saving" : "offline"; this.emit(); clearTimeout(this.timer); this.timer = setTimeout(() => this.sendPending(), 100); });
		this.awareness.on("update", (_changes, origin) => {
			if (this.closed) return;
			if (origin !== "server" && !this.awarenessTimer) this.awarenessTimer = setTimeout(() => { this.awarenessTimer = null; if (this.socket?.readyState === WebSocket.OPEN && this.ready && !this.closed) this.socket.send(JSON.stringify({ type: "awareness", update: b64(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])) })); }, 250);
			this.emit();
		});
	}
	subscribe(listener) { this.listeners.add(listener); listener(this); return () => this.listeners.delete(listener); }
	emit() { for (const listener of this.listeners) listener(this); }
	async connect() {
		if (this.closed || this.fatal) return;
		this.status = "connecting"; this.ready = false; this.emit();
		try {
			const response = await this.connectAction();
			if (response.error) throw new Error(response.error);
			const socket = new WebSocket(response.url, ["flockstack-collaboration", `ticket.${response.ticket}`]); this.socket = socket;
			socket.addEventListener("message", event => this.receive(JSON.parse(event.data)));
			socket.addEventListener("close", event => { this.ready = false; clearInterval(this.heartbeat); if (this.closed) return; if ([4003, 4009].includes(event.code)) { this.fatal = true; this.error = "The document or your access changed. Keep a copy and reopen the current draft."; this.status = "conflict"; } else { this.status = "offline"; this.reconnectTimer = setTimeout(() => this.connect(), 1500); } this.emit(); });
			socket.addEventListener("error", () => { this.status = "offline"; this.emit(); });
		} catch (error) { this.error = error.message; this.status = "unavailable"; this.emit(); }
	}
	receive(message) {
		if (message.type === "ready") {
			if (this.epoch && this.epoch !== message.epoch) { this.fatal = true; this.status = "conflict"; this.error = "The saved document changed. Keep your local copy and reopen its current version."; this.socket.close(); this.emit(); return; }
			if (!this.epoch) this.doc.clientID = message.clientId;
			else if (this.doc.clientID !== message.clientId) { removeAwarenessStates(this.awareness, [this.doc.clientID], "server"); this.doc.clientID = message.clientId; }
			this.awareness.clientID = message.clientId; this.epoch = message.epoch; this.user = message.user; this.role = message.role;
			Y.applyUpdate(this.doc, bytes(message.state), "server"); this.ready = true;
			this.awareness.setLocalState({ user: message.user });
			const server = new Y.Doc(); Y.applyUpdate(server, bytes(message.state));
			const synced = Y.equalSnapshots(Y.snapshot(this.doc), Y.snapshot(server)); server.destroy();
			const update = Y.encodeStateAsUpdate(this.doc, bytes(message.vector)); this.pending = synced ? [] : [update];
			this.ack = this.sequence; this.status = this.pending.length ? "saving" : "saved"; this.sendPending();
			clearInterval(this.heartbeat); this.onReady?.();
			this.heartbeat = setInterval(() => { if (this.ready && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "ping" })); }, 10000);
		} else if (message.type === "update") Y.applyUpdate(this.doc, bytes(message.update), "server");
		else if (message.type === "awareness") applyAwarenessUpdate(this.awareness, bytes(message.update), "server");
		else if (message.type === "ack") { this.ack = Math.max(this.ack, message.sequence); if (!this.pending.length && this.ack >= this.sequence) this.status = "saved"; this.checkpointAt = message.checkpointAt; this.sendPending(); }
		else if (message.type === "flushed") { const waiter = this.waiters.get(message.requestId); if (waiter && !this.fatal) { this.ack = Math.max(this.ack, waiter.sequence); if (!this.pending.length && this.ack >= this.sequence) this.status = "saved"; } this.sendPending(); waiter?.resolve(!this.fatal); this.waiters.delete(message.requestId); }
		else if (message.type === "threads_changed") this.onThreadsChanged?.();
		else if (message.type === "error") { this.error = message.detail ?? message.message; this.fatal = true; this.status = "conflict"; }
		this.emit();
	}
	sendPending() {
		if (!this.ready || this.socket?.readyState !== WebSocket.OPEN || !this.pending.length || this.fatal || this.ack < this.sequence) return;
		const update = Y.mergeUpdates(this.pending);
		if (update.byteLength > 128000) { this.error = "This single update is too large. Keep a copy and use the regular editor."; this.fatal = true; this.status = "conflict"; this.emit(); return; }
		this.pending = []; this.sequence++;
		try { this.socket.send(JSON.stringify({ type: "update", update: b64(update), sequence: this.sequence })); } catch { this.ready = false; this.status = "offline"; this.emit(); }
	}
	replaceText(key, value) {
		if (!this.epoch || this.role === "viewer" || this.fatal || !["subject", "previewText"].includes(key)) return;
		const text = this.doc.getText(key), old = text.toString(); let start = 0, end = 0;
		while (start < old.length && start < value.length && old[start] === value[start]) start++;
		while (end < old.length - start && end < value.length - start && old[old.length - 1 - end] === value[value.length - 1 - end]) end++;
		this.doc.transact(() => { text.delete(start, old.length - start - end); text.insert(start, value.slice(start, value.length - end)); });
	}
	async flush() {
		const deadline = Date.now() + 10000;
		while (this.ready && this.socket?.readyState === WebSocket.OPEN && !this.fatal && Date.now() < deadline) {
			clearTimeout(this.timer); this.sendPending();
			if (this.fatal) return false;
			const requestId = crypto.randomUUID();
			const confirmed = await new Promise(resolve => { const timeout = setTimeout(() => { this.waiters.delete(requestId); resolve(false); }, Math.max(1, deadline - Date.now())); this.waiters.set(requestId, { sequence: this.sequence, resolve: ok => { clearTimeout(timeout); resolve(ok); } }); try { this.socket.send(JSON.stringify({ type: "flush", requestId })); } catch { clearTimeout(timeout); this.waiters.delete(requestId); resolve(false); } });
			if (!confirmed) return false;
			if (!this.dirty) return true;
		}
		return false;
	}

	async disposeAfterFlush() { try { if (this.dirty && this.ready && !this.fatal) await this.flush(); } catch {} finally { this.destroy(); } }
	get dirty() { return this.pending.length > 0 || this.ack < this.sequence; }
	destroy() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.reconnectTimer); clearTimeout(this.awarenessTimer); clearInterval(this.heartbeat); this.socket?.close(); this.awareness.destroy(); this.doc.destroy(); this.listeners.clear(); for (const waiter of this.waiters.values()) waiter.resolve(false); }
}
