import "server-only";
import mongoose from "@/lib/docdb";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { campaignContentHash } from "@/lib/campaign-content-hash";
import { readCollaborationTicket } from "@/lib/collaboration-ticket";
import { connectDb } from "@/lib/db";
import { isUserAllowed } from "@/lib/accounts";
import { isCloud } from "@/lib/config";
import { getTeamRole } from "@/lib/team";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import CampaignCollaboration from "@/models/CampaignCollaboration";

export const editorDisplayName = user => typeof user?.name === "string" && !user.name.includes("@") ? user.name.trim().slice(0, 80) || "Writer" : "Writer";
export async function currentCollaboration(reference) {
	if (process.env.COLLABORATION_ENABLED !== "true" || !reference || ![reference.accountId, reference.campaignId, reference.userId, reference.sessionId].every(value => isObjectIdString(value))) throw actionError("forbidden", "Collaborative editing is unavailable");
	await connectDb();
	const session = await mongoose.connection.db.collection("sessions").findOne({ _id: new mongoose.Types.ObjectId(reference.sessionId), userId: new mongoose.Types.ObjectId(reference.userId) });
	const user = session && await mongoose.connection.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(reference.userId) });
	const account = user && await Account.findById(reference.accountId).lean();
	if (!session || +new Date(session.expiresAt) <= Date.now() || !user?.emailVerified || !account || isDeletionPending(account) || !isCloud() && !isUserAllowed(user)) throw actionError("forbidden", "Your editing session is no longer active");
	const actor = { ...user, id: String(user._id) }, role = await getTeamRole(account, actor);
	if (!role) throw actionError("forbidden", "Your team access is no longer active");
	const campaign = await Campaign.findOne(scoped(account, { _id: reference.campaignId, status: "draft", format: "rich", kind: { $ne: "note" } })).lean();
	if (!campaign) throw actionError("conflict", "This issue is no longer a rich-text draft. Reload its current version.");
	return { account, user: actor, campaign, role, fingerprint: campaignContentHash(campaign), reference: { accountId: String(account._id), campaignId: String(campaign._id), userId: actor.id, sessionId: String(session._id) } };
}
export async function inspectCollaboration(reference) {
	const context = await currentCollaboration(reference), { campaign } = context;
	const snapshot = await CampaignCollaboration.findOne(scoped(context.account, { campaignId: campaign._id, fingerprint: context.fingerprint })).lean();
	return { reference: context.reference, role: context.role, name: editorDisplayName(context.user), fingerprint: context.fingerprint, campaign: { subject: campaign.subject ?? "", previewText: campaign.previewText ?? "", html: campaign.html ?? "" }, snapshot: snapshot ? { state: snapshot.state, epoch: snapshot.epoch } : null };
}
export async function inspectCollaborationTicket(token) {
	const reference = readCollaborationTicket(token);
	if (!reference) throw actionError("forbidden", "This editing ticket expired. Reopen the editor.");
	return inspectCollaboration(reference);
}
