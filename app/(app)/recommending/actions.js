"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const PATH = "/recommending";

// Each one answers { ok, output } or { error } for the form's toast.
export async function saveRecommendationSettings({ newsletterId, allowIncoming, listed }) {
	const { output, failure } = await runDashboardAction("set_recommendation_settings", {
		newsletter: String(newsletterId ?? ""),
		allowIncoming: allowIncoming === true,
		listed: listed === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath(PATH);
	return { ok: true, output };
}

export async function addRecommendation({ newsletterId, slug, pitch }) {
	const { output, failure } = await runDashboardAction("add_recommendation", {
		newsletter: String(newsletterId ?? ""),
		slug: String(slug ?? ""),
		pitch: String(pitch ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath(PATH);
	return { ok: true, output };
}

export async function savePitch({ newsletterId, id, pitch }) {
	const { output, failure } = await runDashboardAction("update_recommendation", {
		newsletter: String(newsletterId ?? ""),
		id: String(id ?? ""),
		pitch: String(pitch ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath(PATH);
	return { ok: true, output };
}

export async function removeRecommendation({ newsletterId, id }) {
	const { output, failure } = await runDashboardAction("remove_recommendation", {
		newsletter: String(newsletterId ?? ""),
		id: String(id ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath(PATH);
	return { ok: true, output };
}

export async function decideRecommendation({ newsletterId, id, decision, reason }) {
	const { output, failure } = await runDashboardAction("update_recommendation", {
		newsletter: String(newsletterId ?? ""),
		id: String(id ?? ""),
		decision: decision === "restore" ? "restore" : "decline",
		...(reason && { reason: String(reason) }),
	});
	if (failure) return toFormError(failure);
	revalidatePath(PATH);
	return { ok: true, output };
}

export async function searchNewsletters({ query, page }) {
	const { output, failure } = await runDashboardAction("search_recommendable_newsletters", {
		...(query && { query: String(query) }),
		page: Number(page) || 1,
	});
	return failure ? toFormError(failure) : { ok: true, output };
}
