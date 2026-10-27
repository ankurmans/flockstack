import { campaignContentHash } from "@/lib/campaign-content-hash";
import { afterCursor, encodeCursor } from "@/lib/actions/shared";
import { isObjectIdString } from "@/lib/validation";
import { after } from "@/lib/runtime-hooks";
import { notifyEditorThreads } from "@/lib/collaboration-storage";
import "server-only";
import { randomUUID } from "node:crypto";
import mongoose from "@/lib/docdb";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { editorDisplayName } from "@/lib/collaboration-authority";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import CampaignCollaboration from "@/models/CampaignCollaboration";
import EditorThread from "@/models/EditorThread";
import TeamSeat from "@/models/TeamSeat";

export async function editorCollaborators(account) {
	const fresh = await Account.findById(account._id).lean();
	const seats = await TeamSeat.find(scoped(account, { status: "active" })).select("userId role").lean();
	const roles = new Map([[String(fresh.ownerId), "owner"], ...seats.filter(seat => seat.userId).map(seat => [String(seat.userId), seat.role])]);
	const users = await mongoose.connection.db.collection("users").find({ _id: { $in: [...roles.keys()].map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
	return users.filter(user => user.emailVerified).map(user => ({ id: String(user._id), name: editorDisplayName(user), role: roles.get(String(user._id)) }));
}
export async function editorCampaign(account, id, writing = false) {
	const campaign = isObjectIdString(String(id)) ? await Campaign.findOne(scoped(account, { _id: id })).lean() : null;
	if (!campaign) throw actionError("not_found", "Issue not found");
	if (writing && campaign.status !== "draft") throw actionError("conflict", "Private editor comments can change only while the issue is a draft");
	return campaign;
}
const actorId = ({ user, apiKey, connection }) => user?.id ? String(user.id) : `agent:${apiKey?._id ?? connection?._id ?? "owner"}`;
async function checkedMentions(account, mentions = []) {
	const active = new Set((await editorCollaborators(account)).map(member => member.id));
	const unique = [...new Set(mentions)];
	if (unique.some(id => !active.has(id))) throw actionError("validation_failed", "Mentions must name current active collaborators");
	return unique;
}
export function editorThreadOutput(row, epoch, viewerId = null) {
	const iso = value => value ? new Date(value).toISOString() : null;
	return { id: String(row._id), campaignId: String(row.campaignId), epoch: row.epoch, outdated: row.epoch !== epoch, anchor: row.anchor ?? null, authorId: row.authorId ?? null, authorName: row.authorName, body: row.removedAt ? "" : row.body, mentions: row.removedAt ? [] : row.mentions ?? [], mentionedYou: Boolean(viewerId && row.mentions?.includes(viewerId)), replies: (row.replies ?? []).map(reply => ({ id: reply.id, authorId: reply.authorId, authorName: reply.authorName, body: reply.body, mentions: reply.mentions ?? [], createdAt: iso(reply.createdAt), mentionedYou: Boolean(viewerId && reply.mentions?.includes(viewerId)) })), resolvedAt: iso(row.resolvedAt), removedAt: iso(row.removedAt), createdAt: iso(row.createdAt) };
}
export async function listEditorThreads({ account, input, user }) {
	const campaign = await editorCampaign(account, input.id);
	const state = await CampaignCollaboration.findOne(scoped(account, { campaignId: input.id })).select("epoch fingerprint").lean();
	const epoch = state?.fingerprint === campaignContentHash(campaign) ? state.epoch : null;
	const rows = await EditorThread.find(scoped(account, { campaignId: input.id, ...(input.cursor && afterCursor(input.cursor, "createdAt")) })).sort({ createdAt: -1, _id: -1 }).limit(input.limit + 1).lean(), page = rows.slice(0, input.limit);
	return { threads: page.map(row => editorThreadOutput(row, epoch, user?.id ? String(user.id) : null)), epoch, nextCursor: rows.length > input.limit ? encodeCursor(page.at(-1).createdAt, page.at(-1)._id) : null };
}
export async function addEditorThread(context) {
	const { account, input, user } = context, campaign = await editorCampaign(account, input.id, true);
	const existing = await EditorThread.findOne(scoped(account, { externalId: input.externalId })).lean();
	if (existing) { if (String(existing.campaignId) !== input.id || existing.authorId !== actorId(context) || existing.body !== input.body) throw actionError("conflict", "This comment ID belongs to another request"); return { thread: editorThreadOutput(existing, input.epoch, user?.id) }; }
	const state = await CampaignCollaboration.findOne(scoped(account, { campaignId: campaign._id, epoch: input.epoch })).lean();
	if (!state || state.fingerprint !== campaignContentHash(campaign)) throw actionError("conflict", "The document changed outside this editing session. Reload before commenting.");
	if (await EditorThread.countDocuments(scoped(account, { campaignId: campaign._id })) >= 100) throw actionError("conflict", "This issue has reached its 100 private thread limit");
	const mentions = await checkedMentions(account, input.mentions);
	let thread;
	for (let attempt = 0; attempt < 16 && !thread; attempt++) {
		const rows = await EditorThread.find(scoped(account, { campaignId: campaign._id })).select("slot").limit(100).lean();
		if (rows.length >= 100) throw actionError("conflict", "This issue has reached its 100 private thread limit");
		const used = new Set(rows.map(row => row.slot)), slot = Array.from({ length: 100 }, (_, index) => String(index + 1)).find(value => !used.has(value));
		try { thread = (await EditorThread.create({ accountId: account._id, newsletterId: campaign.newsletterId, campaignId: campaign._id, externalId: input.externalId, slot, epoch: input.epoch, anchor: input.anchor ?? null, authorId: actorId(context), authorName: user ? editorDisplayName(user) : "Agent", body: input.body, mentions })).toObject(); }
		catch (error) {
			if (error?.code !== 11000) throw error;
			const existing = await EditorThread.findOne(scoped(account, { externalId: input.externalId })).lean();
			if (existing) { if (String(existing.campaignId) !== input.id || existing.authorId !== actorId(context) || existing.body !== input.body) throw actionError("conflict", "This comment ID belongs to another request"); thread = existing; }
		}
	}
	if (!thread) throw actionError("conflict", "Other private comments arrived together. Retry the same comment ID.");
	after(() => notifyEditorThreads(account, campaign._id).catch(() => {}));
	return { thread: editorThreadOutput(thread, input.epoch, user?.id) };
}
export async function changeEditorThread(context) {
	const { account, input, user } = context;
	const thread = isObjectIdString(input.id) ? await EditorThread.findOne(scoped(account, { _id: input.id })).lean() : null;
	if (!thread) throw actionError("not_found", "Private editor thread not found");
	await editorCampaign(account, thread.campaignId, true);
	const filter = scoped(account, { _id: thread._id, revision: thread.revision, removedAt: { $exists: false } });
	let set;
	if (input.kind === "reply") {
		const previous = thread.replies?.find(reply => reply.id === input.externalId);
		if (previous) { if (previous.body !== input.body || previous.authorId !== actorId(context)) throw actionError("conflict", "This reply ID belongs to another request"); return { id: input.id, changed: false }; }
		if ((thread.replies?.length ?? 0) >= 50) throw actionError("conflict", "This thread has reached its 50 reply limit");
		const mentions = await checkedMentions(account, input.mentions);
		set = { replies: [...(thread.replies ?? []), { id: input.externalId ?? randomUUID(), authorId: actorId(context), authorName: user ? editorDisplayName(user) : "Agent", body: input.body, mentions, createdAt: new Date() }] };
	} else if (input.kind === "resolve") { if (Boolean(thread.resolvedAt) === input.resolved) return { id: input.id, changed: false }; set = input.resolved ? { resolvedAt: new Date(), resolvedBy: actorId(context) } : null; }
	else if (input.kind === "remove") {
		if (String(account.ownerId) !== String(user?.id) && thread.authorId !== actorId(context)) throw actionError("forbidden", "Only the author or owner can remove this private thread");
		if (thread.removedAt) return { id: input.id, changed: false };
		set = { removedAt: new Date(), body: "", mentions: [], replies: [], anchor: null };
	}
	const result = await EditorThread.updateOne(filter, { ...(set ? { $set: set } : { $unset: { resolvedAt: 1, resolvedBy: 1 } }), $inc: { revision: 1 } });
	if (!result.matchedCount) throw actionError("conflict", "The thread changed. Refresh before retrying.");
	after(() => notifyEditorThreads(account, thread.campaignId).catch(() => {}));
	return { id: input.id, changed: true };
}
