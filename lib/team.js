import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { TEAM_ROLE_CLASSES, getActionClass } from "@/lib/action-scopes";
import { normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import TeamSeat from "@/models/TeamSeat";

export const TEAM_COOKIE = "flockstack.workspace";
export function isAccountOwner(account, user) { return Boolean(user?.id && String(account.ownerId) === String(user.id)); }
export function requireOwner(account, user) {
	if (!isAccountOwner(account, user)) throw actionError("forbidden", "Only the account owner can do this");
}
export async function getTeamRole(account, user) {
	if (isAccountOwner(account, user)) return "owner";
	if (!user?.id || !user.emailVerified) return null;
	return (await TeamSeat.findOne(scoped(account, { userId: String(user.id), status: "active" })).select({ role: 1 }).lean())?.role ?? null;
}
// The newsletters whose agents' requests this person may decide: null for the owner (all of them), else the IDs the owner
// named on their seat, or none.
export async function getApproverNewsletters(account, user) {
	if (isAccountOwner(account, user)) return null;
	if (!user?.id || !user.emailVerified) return [];
	const seat = await TeamSeat.findOne(scoped(account, { userId: String(user.id), status: "active" })).select({ approverFor: 1 }).lean();
	return seat?.approverFor ?? [];
}
export async function assertTeamAction(account, user, action, input) {
	if (["select_team_workspace", "accept_team_invitation"].includes(action.name) && user?.emailVerified) return;
	if (isAccountOwner(account, user)) return;
	// An approver's own check is per request, in decideApproval: their newsletters, and never billing.
	if (action.name === "decide_approval" && (await getApproverNewsletters(account, user)).length > 0) return;
	const role = await getTeamRole(account, user);
	const scope = getActionClass(action.name, input);
	const allowed = TEAM_ROLE_CLASSES[role] ?? [];
	if (!allowed.includes(scope)) throw actionError("forbidden", "Your team role does not allow this action. Keys, billing, money, exports and approvals need the owner.");
}
export async function resolveTeamAccount(user, selected) {
	if (!/^[a-f0-9]{24}$/.test(selected ?? "") || !user.emailVerified) return null;
	const account = await Account.findById(selected).lean();
	if (!account || account.deletion?.requestedAt) return null;
	const role = await getTeamRole(account, user);
	return role ? { ...account, memberRole: role } : null;
}
export async function listTeam(account, user) {
	requireOwner(account, user);
	const seats = await TeamSeat.find(scoped(account, { status: { $ne: "revoked" } })).sort({ createdAt: 1 }).limit(100).lean();
	return { seats: seats.map((seat) => ({ id: String(seat._id), email: seat.email, role: seat.role, status: seat.status, approverFor: seat.approverFor ?? [] })) };
}
// Names the newsletters whose agents' requests a team member may approve. Owner only, in the dashboard.
export async function setTeamApprover(account, user, { id, newsletterIds }) {
	requireOwner(account, user);
	const update = newsletterIds.length > 0 ? { $set: { approverFor: newsletterIds } } : { $unset: { approverFor: 1 } };
	const result = await TeamSeat.updateOne(scoped(account, { _id: id, status: { $ne: "revoked" } }), update);
	if (!result.matchedCount) throw actionError("not_found", "Team seat not found");
	return { approverFor: newsletterIds };
}
export async function inviteTeamMember(account, user, input) {
	requireOwner(account, user);
	const email = normalizeEmail(input.email);
	if (!email) throw actionError("validation_failed", "Enter a valid email");
	if (email === normalizeEmail(user.email)) throw actionError("validation_failed", "You already own this account");
	if (await TeamSeat.countDocuments(scoped(account, { status: { $ne: "revoked" } })) >= 99) throw actionError("validation_failed", "This account has reached its 100-seat limit, including its owner");
	const existing = await TeamSeat.findOne(scoped(account, { email })).lean();
	if (existing && existing.status !== "revoked") throw actionError("conflict", "This person already has a seat; change their role instead");
	const seat = await TeamSeat.findOneAndUpdate(scoped(account, { email }), { $set: { role: input.role, status: "invited", invitedAt: new Date() }, $unset: { userId: 1, acceptedAt: 1 } }, { upsert: true, new: true });
	return { id: String(seat._id), status: "invited", inviteUrl: "/team", message: "Share the team page address. This person must sign in with the invited email and accept. No email was sent." };
}
export async function updateTeamMember(account, user, input) {
	requireOwner(account, user);
	const result = await TeamSeat.updateOne(scoped(account, { _id: input.id, status: { $ne: "revoked" } }), { $set: input.remove ? { status: "revoked" } : { role: input.role } });
	if (!result.matchedCount) throw actionError("not_found", "Team seat not found");
	return { updated: true };
}
export async function acceptTeamInvitation(user, id) {
	if (!user?.emailVerified) throw actionError("forbidden", "Verify your email first");
	const seat = await TeamSeat.findOne({ _id: id, email: normalizeEmail(user.email), status: "invited" }).setOptions({ crossAccount: true }).lean();
	const account = seat && await Account.findById(seat.accountId).lean();
	if (!account || account.deletion?.requestedAt) throw actionError("not_found", "Invitation not found");
	const result = await TeamSeat.updateOne(scoped(account, { _id: id, status: "invited", role: seat.role }), { $set: { status: "active", userId: String(user.id), acceptedAt: new Date() } });
	if (!result.matchedCount) throw actionError("conflict", "This invitation changed. Reload it.");
	return String(account._id);
}

export async function selectTeamWorkspace(user, id, { accept = false } = {}) {
	const selected = accept ? await acceptTeamInvitation(user, id) : id;
	if (!await resolveTeamAccount(user, selected)) throw actionError("forbidden", "Workspace not available");
	const { cookies } = await import("next/headers");
	(await cookies()).set(TEAM_COOKIE, selected, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 30 * 86400 });
	return { selected: true };
}
