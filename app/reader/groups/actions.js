"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAccountSendProblem } from "@/lib/account-state";
import { toActionError } from "@/lib/actions/errors";
import { connectDb } from "@/lib/db";
import { getGroupManagerLink } from "@/lib/group-links";
import { createGroupPortal, listGroupInvoices, refreshGroupBilling } from "@/lib/group-billing";
import { acceptGroupSeat, inviteGroupSeat, readGroupContext, requestGroupManagerEmail, revokeGroupSeat } from "@/lib/group-seats";
import { createGroupCheckout } from "@/lib/group-subscriptions";
import { findSignupNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { getEmailCommentUrl } from "@/lib/reader-links";
import Account from "@/models/Account";

async function limited() {
	await connectDb();
	if (await isRateLimited({ name: "group-public-ip", key: getClientIp(await headers()), limit: 20, window: "10 m" })) throw Object.assign(new Error("Too many requests. Try again later."), { code: "rate_limited" });
}
export async function buyGroup(_previous, form) {
	try {
		await limited();
		const newsletter = await findSignupNewsletter({ slug: String(form.get("newsletter") ?? "").slice(0, 100) });
		if (!newsletter) return { error: "Group subscriptions aren't available right now." };
		const account = await Account.findById(newsletter.accountId).lean();
		const problem = getAccountSendProblem(account);
		if (problem) return { error: "Group subscriptions aren't available right now." };
		const [tierId, option] = String(form.get("plan") ?? "").split(":");
		return await createGroupCheckout({ account, newsletter, input: { email: String(form.get("email") ?? ""), seats: Number(form.get("seats")), tierId, option, externalId: String(form.get("externalId") ?? "") } });
	} catch (error) { return { error: toActionError(error).message }; }
}
export async function requestManagerEmail(_previous, form) {
	try {
		await limited();
		const newsletter = await findSignupNewsletter({ slug: String(form.get("newsletter") ?? "").slice(0, 100) });
		if (newsletter) await requestGroupManagerEmail({ newsletter, email: String(form.get("email") ?? "") });
		return { ok: true, message: "If this address bought a group, its management link will arrive by email." };
	} catch (error) { return { error: toActionError(error).message }; }
}
export async function acceptSeat(_previous, form) {
	try {
		await limited();
		const result = await acceptGroupSeat({ token: String(form.get("token") ?? ""), email: String(form.get("email") ?? ""), subscribe: form.get("subscribe") === "on" });
		revalidatePath("/reader/groups/invite");
		return { ok: true, message: "Your group seat is accepted.", ...(result.newsletter.archiveEnabled && { continueUrl: getEmailCommentUrl({ contactId: result.contact._id, newsletterId: result.newsletter._id }, result.newsletter) }) };
	} catch (error) { return { error: toActionError(error).message }; }
}
export async function manageGroup(_previous, form) {
	try {
		await limited();
		const { account, group, reference } = await readGroupContext(String(form.get("token") ?? ""), "manager");
		const operation = String(form.get("operation") ?? "");
		if (operation === "invite") {
			const result = await inviteGroupSeat({ account, groupId: group._id, email: String(form.get("email") ?? ""), managerVersion: reference.version });
			revalidatePath("/reader/groups/manage");
			return result.sent ? { ok: true, message: "Invitation sent" } : { error: "The seat is reserved, but its invitation couldn't be sent. Ask the creator to review sending settings." };
		}
		if (operation === "revoke") {
			await revokeGroupSeat({ account, groupId: group._id, seatId: String(form.get("seatId") ?? ""), managerVersion: reference.version });
			revalidatePath("/reader/groups/manage"); return { ok: true, message: "Seat revoked" };
		}
		if (operation === "refresh") {
			await refreshGroupBilling({ account, groupId: group._id });
			revalidatePath("/reader/groups/manage"); return { ok: true, message: "Billing refreshed" };
		}
		if (operation === "billing") return { billingUrl: (await createGroupPortal({ account, groupId: group._id, returnUrl: getGroupManagerLink(group) })).url };
		if (operation === "invoices") return await listGroupInvoices({ account, groupId: group._id, after: String(form.get("after") ?? "") || undefined });
		return { error: "Choose a group action." };
	} catch (error) { return { error: toActionError(error).message }; }
}
