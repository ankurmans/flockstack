import { WorkerEntrypoint } from "cloudflare:workers";
const records = new Map(), revoked = new Set();
export class Authority extends WorkerEntrypoint {
	async seed(reference, campaign, role = "editor") { const key = `${reference.accountId}/${reference.campaignId}`; records.set(key, { reference, campaign, role, name: "Test writer", fingerprint: crypto.randomUUID(), snapshot: null, draft: true }); revoked.delete(reference.sessionId); return key; }
	async inspect(reference) { const row = records.get(`${reference.accountId}/${reference.campaignId}`); if (!row || !row.draft || revoked.has(reference.sessionId)) throw new Error("Forbidden"); return { ...row, reference }; }
	async inspectTicket(ticket) { const reference = JSON.parse(atob(ticket)); return this.inspect(reference); }
	async authorize(reference) { try { const row = await this.inspect(reference); return { role: row.role, name: row.name, reference, fingerprint: row.fingerprint }; } catch { return { allowed: false }; } }
	async checkpoint(reference, input) { const row = await this.inspect(reference); if (row.role === "viewer" || input.expectedHash !== row.fingerprint) throw new Error("Conflict"); row.campaign = { html: input.html, subject: input.subject, previewText: input.previewText }; row.snapshot = { state: input.state, epoch: input.epoch }; row.fingerprint = crypto.randomUUID(); records.set(`${reference.accountId}/${reference.campaignId}`, row); return { fingerprint: row.fingerprint, checkpointAt: new Date().toISOString() }; }
	async revoke(sessionId) { revoked.add(sessionId); }
	async outside(reference, html) { const row = await this.inspect(reference); row.campaign.html = html; row.fingerprint = crypto.randomUUID(); row.snapshot = null; records.set(`${reference.accountId}/${reference.campaignId}`, row); }
	async lock(reference) { const row = await this.inspect(reference); row.draft = false; records.set(`${reference.accountId}/${reference.campaignId}`, row); }
}
const worker = { fetch() { return new Response("Not found", { status: 404 }); } };
export default worker;
