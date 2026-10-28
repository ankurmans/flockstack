"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const STEPS = ["query", "triage", "extract", "write", "check", "translate"];

function refresh(id) {
	revalidatePath("/briefings");
	if (id) revalidatePath(`/briefings/${id}`);
}

// One host per line or comma, as the form's text boxes take them.
function readHosts(value) {
	return String(value ?? "")
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter(Boolean);
}

// The form's values as the actions take them: whole numbers, examples with an address, the steps that have a key.
function readBriefing(values) {
	const examples = (Array.isArray(values?.examples) ? values.examples : [])
		.filter((example) => String(example?.url ?? "").trim())
		.map((example) => ({ url: String(example.url).trim(), note: String(example.note ?? "") }));
	const steps = Object.fromEntries(
		STEPS.map((step) => {
			const chosen = values?.steps?.[step];
			return [step, chosen?.keyId ? { keyId: String(chosen.keyId), model: String(chosen.model ?? "") } : null];
		})
	);
	return {
		name: String(values?.name ?? ""),
		status: values?.active === true ? "active" : "paused",
		brief: { topic: String(values?.topic ?? ""), audience: String(values?.audience ?? ""), useful: String(values?.useful ?? ""), examples },
		trustedOutlets: readHosts(values?.trustedOutlets),
		blockedHosts: readHosts(values?.blockedHosts),
		discovery: { searchKeyId: values?.searchKeyId ? String(values.searchKeyId) : null, candidateFeedKeyId: values?.candidateFeedKeyId ? String(values.candidateFeedKeyId) : null },
		schedule: { days: (Array.isArray(values?.days) ? values.days : []).map(Number), time: String(values?.time ?? ""), timeZone: String(values?.timeZone ?? "UTC") },
		styleGuide: String(values?.styleGuide ?? ""),
		languages: (Array.isArray(values?.languages) ? values.languages : ["en"]).map(String),
		stories: { minFull: Number(values?.minFull), maxFull: Number(values?.maxFull), briefItems: Number(values?.briefItems) },
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

// Keep or drop on one story of a run, from the run's page.
export async function rateBriefingStory(briefingId, runId, storyKey, verdict) {
	const { output, failure } = await runDashboardAction("rate_briefing_story", { id: String(runId ?? ""), storyKey: String(storyKey ?? ""), verdict: verdict === "drop" ? "drop" : "keep" });
	if (failure) return toFormError(failure);
	revalidatePath(`/briefings/${briefingId}/runs/${runId}`);
	return { ok: true, verdict: output.verdict };
}
