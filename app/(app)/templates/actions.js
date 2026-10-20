"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function refresh() {
	revalidatePath("/templates");
}

export async function renameTemplate(id, name) {
	const { failure } = await runDashboardAction("update_template", { id: String(id ?? ""), name: String(name ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true };
}

export async function deleteTemplate(id) {
	const { failure } = await runDashboardAction("delete_template", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true };
}

// A new snippet when id is empty.
export async function saveSnippet(newsletterId, id, { name, content }) {
	const { failure } = id
		? await runDashboardAction("update_snippet", { id: String(id), name: String(name ?? ""), content: String(content ?? "") })
		: await runDashboardAction("create_snippet", { newsletter: String(newsletterId ?? ""), name: String(name ?? ""), content: String(content ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true };
}

export async function deleteSnippet(id) {
	const { failure } = await runDashboardAction("delete_snippet", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true };
}

// The header and footer new issues start with, and the accent color of their blocks.
export async function saveDefaultStyle(newsletterId, { header, footer, accentColor }) {
	const { failure } = await runDashboardAction("update_newsletter", {
		id: String(newsletterId ?? ""),
		accentColor: String(accentColor ?? ""),
		defaultStyle: { header: String(header ?? ""), footer: String(footer ?? "") },
	});
	if (failure) return toFormError(failure);
	refresh();
	revalidatePath("/newsletters");
	return { ok: true };
}
