"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The builder's form: { name, buttonText, fields, colors, successMessage, redirectUrl }.
function readForm(values) {
	const colors = values?.colors ?? {};
	return {
		name: String(values?.name ?? ""),
		buttonText: String(values?.buttonText ?? ""),
		fields: (Array.isArray(values?.fields) ? values.fields : []).map(String),
		colors: Object.fromEntries(["button", "buttonText", "background", "text"].map((key) => [key, String(colors[key] ?? "")])),
		successMessage: String(values?.successMessage ?? ""),
		redirectUrl: String(values?.redirectUrl ?? ""),
		...(typeof values?.archiveDefault === "boolean" && { archiveDefault: values.archiveDefault }),
		...(Array.isArray(values?.flow) && { flow: values.flow.map(({ type, surveyId }) => ({ type: String(type), ...(surveyId && { surveyId: String(surveyId) }) })) }),
	};
}

export async function createForm(newsletterId, values) {
	const { output, failure } = await runDashboardAction("create_form", { newsletter: String(newsletterId ?? ""), ...readForm(values) });
	if (failure) return toFormError(failure);
	revalidatePath("/forms");
	return { ok: true, id: output.id };
}

export async function updateForm(id, values) {
	const { failure } = await runDashboardAction("update_form", { id: String(id ?? ""), ...readForm(values) });
	if (failure) return toFormError(failure);
	revalidatePath("/forms");
	revalidatePath(`/forms/${id}`);
	return { ok: true };
}

export async function deleteForm(id) {
	const { failure } = await runDashboardAction("delete_form", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/forms");
	return { ok: true };
}

export async function rotateMagicLink(newsletterId) {
	const { failure } = await runDashboardAction("rotate_magic_link", { id: String(newsletterId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/forms/magic");
	return { ok: true };
}

export async function updatePopup(newsletterId, values) {
	const gate = values?.gate ?? {};
	const { failure } = await runDashboardAction("update_popup_settings", {
		newsletter: String(newsletterId ?? ""),
		enabled: values?.enabled === true,
		trigger: String(values?.trigger ?? ""),
		seconds: Number(values?.seconds),
		scrollPercent: Number(values?.scrollPercent),
		frequencyDays: Number(values?.frequencyDays),
		pages: String(values?.pages ?? ""),
		gate: { enabled: gate.enabled === true, previewPercent: Number(gate.previewPercent), freeLatest: Number(gate.freeLatest) },
	});
	if (failure) return toFormError(failure);
	revalidatePath("/forms/popup");
	return { ok: true };
}
