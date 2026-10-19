"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function refresh(id) {
	revalidatePath("/automations");
	if (id) revalidatePath(`/automations/${id}`);
}

const FIELD_ERRORS = [
	[/^name: /, "Name the automation"],
	[/^trigger: tag_added needs a tag/, "Pick the tag that starts it"],
	[/^trigger: segment_joined needs a segment/, "Pick the segment that starts it"],
	[/^trigger: date_field needs a field/, "Pick the date field that starts it"],
	[/^trigger: tag isn't a valid tag/, "The tag that starts it isn't a valid tag: letters, digits, spaces and - _ . : / + &"],
];

// The editor numbers steps from 1 and has no field names: "steps[2]: add_tag needs a tag" is the API's way of saying
// "Step 3 needs a tag".
function toEditorError(failure) {
	if (failure.code !== "validation_failed") return toFormError(failure);
	const field = FIELD_ERRORS.find(([pattern]) => pattern.test(failure.message));
	if (field) return { error: field[1] };
	const step = (index) => `Step ${Number(index) + 1}`;
	const message = failure.message
		.replace(/^steps\[(\d+)\]: (?:add_tag|remove_tag) needs a tag/, (_, index) => `${step(index)} needs a tag`)
		.replace(/^steps\[(\d+)\]: /, (_, index) => `${step(index)}: `);
	return { error: message };
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
	// The editor sends the tag field as it is; empty, the action reads it as a tag that isn't valid.
	if (trigger?.type === "tag_added" && !String(trigger.tag ?? "").trim()) return { error: "Pick the tag that starts it" };
	const { failure } = await runDashboardAction("update_automation", {
		id: String(id),
		name: String(name ?? ""),
		...(trigger && { trigger }),
		...(Array.isArray(steps) && { steps }),
	});
	if (failure) return toEditorError(failure);
	refresh(id);
	return { ok: true };
}

export async function activateAutomation(id) {
	const { failure } = await runDashboardAction("activate_automation", { id: String(id) });
	if (failure) return toEditorError(failure);
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
