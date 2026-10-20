"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function saveLinkPage({ newsletterId, enabled, title, bio, links }) {
	const { failure } = await runDashboardAction("update_link_page", {
		newsletter: String(newsletterId ?? ""),
		enabled: enabled === true,
		title: String(title ?? ""),
		bio: String(bio ?? ""),
		links: (Array.isArray(links) ? links : []).map(({ label, url }) => ({ label: String(label ?? ""), url: String(url ?? "") })),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/link-page");
	return { ok: true, savedAt: Date.now() };
}
