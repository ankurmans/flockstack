"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function saveCommentSettings({ newsletterId, enabled, who, moderation, notifyOwner }) {
	const { failure } = await runDashboardAction("set_comment_settings", {
		newsletter: String(newsletterId ?? ""),
		enabled: enabled === true,
		who: String(who ?? ""),
		moderation: String(moderation ?? ""),
		notifyOwner: notifyOwner === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/comments");
	return { ok: true, savedAt: Date.now() };
}

// mode: on, off or default, for one issue.
export async function setIssueComments({ newsletterId, campaignId, mode }) {
	const { failure } = await runDashboardAction("set_comment_settings", {
		newsletter: String(newsletterId ?? ""),
		campaign: String(campaignId ?? ""),
		issueComments: String(mode ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/comments");
	return { ok: true };
}

export async function decideComment({ id, action, reason }) {
	const { failure } = await runDashboardAction("moderate_comment", { id: String(id ?? ""), action: String(action ?? ""), reason: String(reason ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/comments");
	return { ok: true };
}

export async function blockReader({ contactId, reason }) {
	const { failure } = await runDashboardAction("block_commenter", { contact: String(contactId ?? ""), reason: String(reason ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/comments");
	return { ok: true };
}

export async function unblockReader({ contactId }) {
	const { failure } = await runDashboardAction("unblock_commenter", { contact: String(contactId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/comments");
	return { ok: true };
}
