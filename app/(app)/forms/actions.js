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
