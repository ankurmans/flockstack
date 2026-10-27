"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function saveReferralSettings({ newsletterId, enabled, rewards }) {
	const { failure, output } = await runDashboardAction("update_referral_settings", {
		newsletter: String(newsletterId ?? ""),
		enabled: enabled === true,
		rewards: (Array.isArray(rewards) ? rewards : []).map(({ id, referrals, title, url, text, kind, tierId, months }) => ({
			...(id && { id: String(id) }),
			referrals: Number(referrals),
			title: String(title ?? ""),
			url: String(url ?? ""),
			text: String(text ?? ""),
			...(kind && { kind }),
			...(kind === "gift" && { tierId: String(tierId ?? ""), months: Number(months) }),
		})),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/referrals");
	return { ok: true, savedAt: Date.now(), settings: output };
}

export async function saveReferralCodes({ newsletterId, rewardId, codes }) {
	const { failure, output } = await runDashboardAction("add_referral_codes", { newsletter: String(newsletterId ?? ""), rewardId: String(rewardId ?? ""), codes });
	if (failure) return toFormError(failure);
	revalidatePath("/referrals");
	return output;
}

export async function fulfillReferralRewards({ newsletterId, cursor }) {
	const { failure, output } = await runDashboardAction("fulfill_referral_rewards", { newsletter: String(newsletterId ?? ""), ...(cursor && { cursor }) });
	if (failure) return toFormError(failure);
	revalidatePath("/referrals");
	return output;
}
