import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem, isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { getSignupProblem, upsertContact } from "@/lib/contacts";
import { getGroupManagerLink, getGroupSeatLink, readGroupToken } from "@/lib/group-links";
import { findGroup, changeGroupSeats } from "@/lib/group-store";
import { reconcileGroupReaders, refreshGroupBilling } from "@/lib/group-billing";
import { updatePaidAccess } from "@/lib/paid-access";
import { getReaderText } from "@/lib/reader-languages";
import { limitKey } from "@/lib/reader-links";
import { isRateLimited } from "@/lib/rate-limit";
import { normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import GroupSubscription from "@/models/GroupSubscription";
import Newsletter from "@/models/Newsletter";
import Suppression from "@/models/Suppression";

const clean = value => String(value ?? "").replace(/[\r\n\[\]()*_`<>!\\]/g, " ").trim();
const liveSeats = group => (group.seats ?? []).filter(seat => seat.status !== "revoked");
const funded = group => group.status === "active" && group.subscriptionStatus === "active" && Number.isInteger(group.capacity) && group.capacity > 0 && +new Date(group.paidUntil) > Date.now();
const availableSeat = (group, id) => funded(group) && liveSeats(group).slice(0, group.capacity).some(seat => seat.id === id);
const expired = () => actionError("not_found", "This group link expired or is no longer available. Ask for a new email.");

async function accountForChange(account) {
	const current = await Account.findById(account?._id ?? account).lean();
	if (!current || isDeletionPending(current)) throw expired();
	const problem = getAccountSendProblem(current);
	if (problem) throw actionError(problem.code, problem.message);
	return current;
}

export async function readGroupContext(token, kind) {
	const reference = readGroupToken(token, kind);
	if (!reference) throw expired();
	const account = await Account.findById(reference.accountId).lean();
	if (!account || isDeletionPending(account)) throw expired();
	const group = await GroupSubscription.findOne(scoped(account, { _id: reference.groupId, newsletterId: reference.newsletterId })).lean();
	const newsletter = group && await Newsletter.findOne(scoped(account, { _id: reference.newsletterId })).lean();
	if (!newsletter || !group) throw expired();
	const seat = kind === "seat" ? group.seats?.find(seat => seat.id === reference.seatId) : null;
	if (kind === "manager" ? !group.buyerVerifiedAt || reference.version !== (group.managerVersion ?? 0) : !seat || seat.status === "revoked" || reference.version !== (seat.invitationVersion ?? 0)) throw expired();
	return { account, newsletter, group, seat, reference };
}

export async function sendGroupManagerLink({ account, groupId, rotate = false, initial = false }) {
	account = await accountForChange(account);
	let group = await findGroup(account, groupId);
	if (!group.buyerVerifiedAt || !group.stripeSubscriptionId) throw actionError("conflict", "Stripe hasn't verified this buyer yet");
	if (initial && group.buyerReceiptSentAt) return { sent: false, alreadySent: true };
	if (await isRateLimited({ name: "group-manager-email", key: String(group._id), limit: 3, window: "1 h" })) throw actionError("rate_limited", "Wait before requesting another group management email");
	if (rotate) {
		await GroupSubscription.updateOne(scoped(account, { _id: group._id }), { $inc: { managerVersion: 1 } });
		group = await findGroup(account, group._id);
	}
	const newsletter = await Newsletter.findOne(scoped(account, { _id: group.newsletterId })).lean();
	if (!newsletter) throw expired();
	const t = getReaderText(newsletter), name = clean(newsletter.name);
	const { sendTransactionalEmail } = await import("@/lib/sending");
	const sent = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: group.buyerEmail, subject: t("Your group subscription to {name}", { name }), reason: t("You bought a group subscription to {name} or requested its management link.", { name }), markdown: [t("Manage your group's seats, invoices and recurring billing. No reader is enrolled until they accept an invitation. Individual subscriptions stay unchanged."), `[${t("Manage your group")}](${getGroupManagerLink(group)})`, t("This private link expires in 7 days. Don't forward it.")].join("\n\n") });
	if (sent.sent) await GroupSubscription.updateOne(scoped(account, { _id: group._id, managerVersion: group.managerVersion ?? 0 }), { $set: { buyerReceiptSentAt: new Date() } });
	return { sent: sent.sent === true };
}

export async function inviteGroupSeat({ account, groupId, email, managerVersion }) {
	account = await accountForChange(account);
	const recipient = normalizeEmail(email ?? "");
	if (!recipient) throw actionError("validation_failed", "Enter a valid recipient email");
	const group = await refreshGroupBilling({ account, groupId });
	if (await isRateLimited({ name: "group-seat-invites", key: String(group._id), limit: 20, window: "10 m" }) || await isRateLimited({ name: "group-seat-recipient", key: limitKey(`${account._id}:${recipient}`), limit: 5, window: "1 d" })) throw actionError("rate_limited", "Wait before sending more seat invitations");
	const signupProblem = await getSignupProblem(recipient);
	if (signupProblem) throw actionError("validation_failed", signupProblem);
	let invitedId;
	const current = await changeGroupSeats(account, groupId, fresh => {
		if (managerVersion !== undefined && managerVersion !== (fresh.managerVersion ?? 0)) throw expired();
		if (!funded(fresh)) throw actionError("conflict", "This group has no currently funded seats");
		const seats = [...(fresh.seats ?? [])];
		const existing = seats.findIndex(seat => seat.email === recipient && seat.status !== "revoked");
		if (existing >= 0) {
			if (seats[existing].status !== "invited") throw actionError("conflict", "This reader already accepted a seat");
			if (!availableSeat(fresh, seats[existing].id)) throw actionError("conflict", "This seat is outside the group's paid capacity");
			if (Date.now() - +new Date(seats[existing].invitedAt) < 60000) throw actionError("rate_limited", "Wait a minute before sending this invitation again");
			invitedId = seats[existing].id;
			seats[existing] = { ...seats[existing], invitationVersion: (seats[existing].invitationVersion ?? 0) + 1, invitedAt: new Date(), invitationSentAt: null };
		} else {
			if (liveSeats(fresh).length >= fresh.capacity) throw actionError("conflict", "Every funded seat is assigned. Revoke a seat before inviting another reader.");
			invitedId = randomUUID();
			const seat = { id: invitedId, email: recipient, status: "invited", invitedAt: new Date(), invitationVersion: 0 };
			const revoked = seats.findIndex(seat => seat.status === "revoked");
			if (revoked >= 0) seats[revoked] = seat; else seats.push(seat);
		}
		return seats;
	});
	const seat = current.seats.find(seat => seat.id === invitedId);
	const newsletter = await Newsletter.findOne(scoped(account, { _id: current.newsletterId })).lean();
	if (!newsletter) throw expired();
	const t = getReaderText(newsletter), name = clean(newsletter.name);
	const { sendTransactionalEmail } = await import("@/lib/sending");
	const sent = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: recipient, subject: t("A group seat for {name}", { name }), reason: t("A group buyer invited this address to {name}. You haven't been subscribed by this invitation.", { name }), markdown: [t("You've been invited to a paid group seat for {name}. Open the private link and choose whether to subscribe and accept. Existing individual billing is unchanged.", { name }), `[${t("Review your invitation")}](${getGroupSeatLink(current, seat)})`, t("This link is for this email address and expires in 7 days. Ignore it to stay unsubscribed.")].join("\n\n") });
	if (sent.sent) await changeGroupSeats(account, groupId, fresh => fresh.seats.some(item => item.id === seat.id && item.invitationVersion === seat.invitationVersion && item.status === "invited") ? fresh.seats.map(item => item.id === seat.id ? { ...item, invitationSentAt: new Date() } : item) : null);
	return { id: seat.id, email: recipient, status: "invited", sent: sent.sent === true };
}

export async function revokeGroupSeat({ account, groupId, seatId, managerVersion }) {
	const group = await changeGroupSeats(account, groupId, fresh => {
		if (managerVersion !== undefined && managerVersion !== (fresh.managerVersion ?? 0)) throw expired();
		const seat = fresh.seats?.find(seat => seat.id === seatId);
		if (!seat) throw actionError("not_found", "Group seat not found");
		return seat.status === "revoked" ? null : fresh.seats.map(item => item.id === seatId ? { ...item, status: "revoked", invitationVersion: (item.invitationVersion ?? 0) + 1 } : item);
	});
	const newsletter = await Newsletter.findOne(scoped(account, { _id: group.newsletterId })).lean();
	if (newsletter) await reconcileGroupReaders(account, newsletter, group);
	return { id: seatId, revoked: true };
}

// The emailed capability proves control of the recipient address. Nothing is enrolled on GET or by an invitation.
// Consent is saved on the seat before creating a subscriber. If the seat is concurrently revoked, that explicit signup
// remains, but no group access is granted; retries can finish a partially accepted seat without adding a second reader.
export async function acceptGroupSeat({ token, email, subscribe }) {
	const context = await readGroupContext(token, "seat");
	const { newsletter, reference } = context;
	const account = await accountForChange(context.account);
	if (subscribe !== true || normalizeEmail(email ?? "") !== context.seat.email) throw actionError("validation_failed", "Confirm the invited email and choose to subscribe before accepting");
	const problem = await getSignupProblem(context.seat.email);
	if (problem) throw actionError("validation_failed", problem);
	if (await Suppression.exists(scoped(account, { email: context.seat.email }))) throw actionError("conflict", "This address can't receive the newsletter. Ask the creator to review its subscriber status.");
	await refreshGroupBilling({ account, groupId: context.group._id });
	await accountForChange(account);
	await changeGroupSeats(account, context.group._id, fresh => {
		const seat = fresh.seats?.find(seat => seat.id === reference.seatId);
		if (!seat || seat.status === "revoked" || seat.invitationVersion !== reference.version) throw expired();
		if (!availableSeat(fresh, seat.id)) throw actionError("conflict", "This invitation has no currently funded seat");
		if (seat.consentedAt) return null;
		return fresh.seats.map(item => item.id === seat.id ? { ...item, status: "accepting", consentedAt: new Date() } : item);
	});
	await accountForChange(account);
	const result = await upsertContact({ newsletter, email: context.seat.email, source: "group", resubscribe: true, consent: { at: new Date() } });
	if (result.contact.status !== "active") throw actionError("conflict", "This address can't receive the newsletter. Ask the creator to review its subscriber status.");
	const contact = result.contact;
	await changeGroupSeats(account, context.group._id, fresh => {
		const seat = fresh.seats?.find(seat => seat.id === reference.seatId);
		if (!seat || seat.status === "revoked" || seat.invitationVersion !== reference.version) throw expired();
		if (seat.contactId && String(seat.contactId) !== String(contact._id)) throw expired();
		return fresh.seats.map(item => item.id === seat.id ? { ...item, contactId: contact._id } : item);
	});
	await updatePaidAccess({ account, newsletter, contactId: contact._id });
	await updatePaidAccess({ account, newsletter, contactId: contact._id, change: fresh => ({ set: { groupIds: [...new Set([...(fresh.groupIds ?? []).map(String), String(context.group._id)])] } }) });
	await changeGroupSeats(account, context.group._id, fresh => {
		const seat = fresh.seats?.find(seat => seat.id === reference.seatId);
		if (!seat || seat.status === "revoked" || seat.invitationVersion !== reference.version || String(seat.contactId) !== String(contact._id)) throw expired();
		if (!availableSeat(fresh, seat.id)) throw actionError("conflict", "This seat is no longer funded");
		return seat.status === "active" ? null : fresh.seats.map(item => item.id === seat.id ? { ...item, status: "active", acceptedAt: new Date() } : item);
	});
	const updated = await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true });
	return { newsletter, contact: updated.contact, groupId: String(context.group._id), seatId: reference.seatId };
}

export async function requestGroupManagerEmail({ newsletter, email }) {
	const address = normalizeEmail(email ?? "");
	if (!address) throw actionError("validation_failed", "Enter a valid email address");
	const groups = await GroupSubscription.find(scoped(newsletter.accountId, { newsletterId: newsletter._id, buyerEmail: address, buyerVerifiedAt: { $exists: true } })).sort({ createdAt: -1 }).limit(20).lean();
	for (const group of groups) {
		try { await sendGroupManagerLink({ account: newsletter.accountId, groupId: group._id }); }
		catch (error) { if (!["rate_limited", "account_blocked", "subscription_required"].includes(error.code)) throw error; }
	}
	return { requested: true };
}
