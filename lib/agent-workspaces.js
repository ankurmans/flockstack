import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { actionError } from "@/lib/actions/errors";
import { BootstrapInput } from "@/lib/agent-bootstrap-schema";
import { bootstrapNewsletter } from "@/lib/agent-bootstrap";
import { isSignedWithAppKey, signWithAppKey } from "@/lib/app-keys";
import { getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { isObjectIdString } from "@/lib/validation";
import AgentWorkspace from "@/models/AgentWorkspace";

const kind = (purpose) => `flockstack-agent-workspace-${purpose}-v1`;
const hash = (token) => createHash("sha256").update(token).digest("hex");
function newToken(purpose) {
	const nonce = randomBytes(24).toString("base64url");
	return `${nonce}.${signWithAppKey(kind(purpose), nonce)}`;
}
function validToken(token, purpose) {
	const [nonce, signature, extra] = String(token ?? "").split(".");
	return !extra && /^[\w-]{32}$/.test(nonce || "") && isSignedWithAppKey(kind(purpose), nonce, signature);
}
export const WorkspaceInput = BootstrapInput.omit({ externalId: true });

async function findWorkspace(id, token, purpose) {
	await connectDb();
	if (!isObjectIdString(String(id)) || !validToken(token, purpose)) throw actionError("not_found", "Workspace link is invalid or expired");
	const row = await AgentWorkspace.findOne({ _id: id, [`${purpose}Hash`]: hash(token), expiresAt: { $gt: new Date() } }).lean();
	if (!row) throw actionError("not_found", "Workspace link is invalid or expired");
	return row;
}

export async function createWorkspace(payload, headers) {
	if (!isCloud()) throw actionError("not_found", "Public draft workspaces are off on this server");
	await connectDb();
	const parsed = WorkspaceInput.safeParse(payload);
	if (!parsed.success) throw actionError("validation_failed", "Give a newsletter name and a brand brief, with exactly four drafts if supplied");
	if (Buffer.byteLength(JSON.stringify(parsed.data)) > 220_000) throw actionError("validation_failed", "The draft workspace is too large");
	const ip = headers.get("cf-connecting-ip") || getClientIp(headers);
	if (await isRateLimited({ name: "agent-workspaces-ip", key: ip, limit: 3, window: "1 d" }) || await isRateLimited({ name: "agent-workspaces-global", key: "all", limit: 100, window: "1 d" })) throw actionError("rate_limited", "Too many new draft workspaces today");
	const draftToken = newToken("draft"), claimToken = newToken("claim");
	const row = await AgentWorkspace.create({ payload: parsed.data, draftHash: hash(draftToken), claimHash: hash(claimToken), expiresAt: new Date(Date.now() + 86_400_000) });
	return { id: String(row._id), level: "drafts", draftToken, claimUrl: `${getAppUrl()}/claim-workspace?id=${row._id}#token=${claimToken}`, expiresAt: row.expiresAt.toISOString(), sent: false };
}

export async function readDraftWorkspace(id, token) {
	const row = await findWorkspace(id, token, "draft");
	if (row.status !== "pending") throw actionError("conflict", "The owner is claiming this workspace");
	return { id: String(row._id), revision: row.revision, payload: row.payload, expiresAt: row.expiresAt.toISOString() };
}

export async function updateDraftWorkspace(id, token, payload, revision) {
	const row = await findWorkspace(id, token, "draft");
	if (row.claimedBy) throw actionError("conflict", "Claim has started. Retry the reviewed revision unchanged, then edit the claimed newsletter.");
	const parsed = WorkspaceInput.safeParse(payload);
	if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data ?? {})) > 220_000) throw actionError("validation_failed", "Invalid workspace brief or drafts");
	const changed = await AgentWorkspace.updateOne({ _id: row._id, status: "pending", revision }, { $set: { payload: parsed.data }, $inc: { revision: 1 } });
	if (!changed.modifiedCount) throw actionError("conflict", "The workspace changed; read it before editing again");
	return { revision: revision + 1 };
}

export async function previewWorkspace({ id, token }) {
	const row = await findWorkspace(id, token, "claim");
	if (row.status === "claimed") throw actionError("conflict", "Workspace has already been claimed");
	return { id: String(row._id), revision: row.revision, name: row.payload.name, brief: row.payload.brief, drafts: row.payload.drafts ?? [], payload: row.payload };
}

export async function claimWorkspace(account, input, user) {
	const row = await findWorkspace(input.id, input.token, "claim");
	if (String(account.ownerId) !== String(user?.id)) throw actionError("forbidden", "Only the account owner can claim a workspace");
	if (row.claimedBy && String(row.claimedBy) !== String(account._id)) throw actionError("forbidden", "This workspace is already being claimed into another account");
	const now = new Date();
	const claimed = await AgentWorkspace.updateOne({ _id: row._id, claimedBy: row.claimedBy ?? null, revision: input.revision, $or: [{ status: "pending" }, { status: "claiming", leaseUntil: { $lt: now } }] }, { $set: { status: "claiming", leaseUntil: new Date(now.getTime() + 180_000), claimedBy: account._id } });
	if (!claimed.modifiedCount) throw actionError("conflict", "The workspace changed or is already being claimed. Preview it again");
	try {
		const result = await bootstrapNewsletter(account, { ...row.payload, externalId: `workspace-${row._id}` }, user);
		await AgentWorkspace.updateOne({ _id: row._id, status: "claiming", claimedBy: account._id }, { $set: { status: "claimed", claimedAt: new Date(), result }, $unset: { claimHash: 1, draftHash: 1, leaseUntil: 1, payload: 1 } });
		return result;
	} catch (error) {
		await AgentWorkspace.updateOne({ _id: row._id, status: "claiming", claimedBy: account._id }, { $set: { status: "pending" }, $unset: { leaseUntil: 1 } });
		throw error;
	}
}

export async function purgeDraftWorkspaces(now = new Date()) {
	return AgentWorkspace.deleteMany({ expiresAt: { $lt: now } });
}
