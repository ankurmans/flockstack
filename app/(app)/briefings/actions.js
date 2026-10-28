"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const STEPS = ["triage", "extract", "write", "check"];

function refresh(id) {
	revalidatePath("/briefings");
	if (id) revalidatePath(`/briefings/${id}`);
}

// The form's values as the actions take them: whole numbers, sources with an address, the steps that have a key.
function readBriefing(values) {
	const sources = (Array.isArray(values?.sources) ? values.sources : [])
		.filter((source) => String(source?.url ?? "").trim())
		.map((source) => ({
			...(source.id && { id: String(source.id) }),
			kind: ["feed", "page", "url"].includes(source.kind) ? source.kind : "feed",
			url: String(source.url).trim(),
			label: String(source.label ?? ""),
		}));
	const steps = Object.fromEntries(
		STEPS.map((step) => {
			const chosen = values?.steps?.[step];
			return [step, chosen?.keyId ? { keyId: String(chosen.keyId), model: String(chosen.model ?? "") } : null];
		})
	);
	return {
		name: String(values?.name ?? ""),
		status: values?.active === true ? "active" : "paused",
		sources,
		schedule: { days: (Array.isArray(values?.days) ? values.days : []).map(Number), time: String(values?.time ?? ""), timeZone: String(values?.timeZone ?? "UTC") },
		audience: String(values?.audience ?? ""),
		styleGuide: String(values?.styleGuide ?? ""),
		languages: (Array.isArray(values?.languages) ? values.languages : ["en"]).map(String),
		maxStories: Number(values?.maxStories),
		minScore: Number(values?.minScore),
		budgetUsd: Number(values?.budgetUsd),
		steps,
		testEmail: String(values?.testEmail ?? "").trim() || null,
	};
}

export async function createBriefing(newsletterId, values) {
	const { output, failure } = await runDashboardAction("create_briefing", { newsletter: String(newsletterId ?? ""), ...readBriefing(values) });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.id };
}

export async function updateBriefing(id, values) {
	const { failure } = await runDashboardAction("update_briefing", { id: String(id ?? ""), ...readBriefing(values) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function deleteBriefing(id) {
	const { failure } = await runDashboardAction("delete_briefing", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function runBriefingNow(id) {
	const { failure } = await runDashboardAction("run_briefing", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}
