"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function refresh(id) {
	revalidatePath("/automations");
	if (id) revalidatePath(`/automations/${id}`);
}

// A draft that starts when a contact subscribes and sends one email, to fill in.
export async function createAutomation(newsletterId) {
	const { output, failure } = await runDashboardAction("create_automation", {
		newsletter: String(newsletterId ?? ""),
		name: "Untitled automation",
		trigger: { type: "subscribed" },
		steps: [{ type: "email", subject: "", previewText: "", format: "rich", content: "" }],
	});
	if (failure) return toFormError(failure);
	refresh();
	redirect(`/automations/${output.id}`);
}

// The name alone while it's active; its trigger and steps too otherwise.
export async function saveAutomation(id, { name, trigger, steps }) {
	const { failure } = await runDashboardAction("update_automation", {
		id: String(id),
		name: String(name ?? ""),
		...(trigger && { trigger }),
		...(Array.isArray(steps) && { steps }),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function activateAutomation(id) {
	const { failure } = await runDashboardAction("activate_automation", { id: String(id) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function pauseAutomation(id) {
	const { failure } = await runDashboardAction("pause_automation", { id: String(id) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function deleteAutomation(id) {
	const { failure } = await runDashboardAction("delete_automation", { id: String(id) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}
