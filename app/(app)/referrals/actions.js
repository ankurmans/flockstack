"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function saveReferralSettings({ newsletterId, enabled, rewards }) {
	const { failure } = await runDashboardAction("update_referral_settings", {
		newsletter: String(newsletterId ?? ""),
		enabled: enabled === true,
		rewards: (Array.isArray(rewards) ? rewards : []).map(({ id, referrals, title, url, text }) => ({
			...(id && { id: String(id) }),
			referrals: Number(referrals),
			title: String(title ?? ""),
			url: String(url ?? ""),
			text: String(text ?? ""),
		})),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/referrals");
	return { ok: true, savedAt: Date.now() };
}
