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
	[/^trigger: (?:tag_added|tag_removed) needs a tag/, "Pick the tag that starts it"],
	[/^trigger: (?:segment_joined|segment_left) needs a segment/, "Pick the segment that starts it"],
	[/^trigger: date_field needs a field/, "Pick the date field that starts it"],
	[/^trigger: field_changed needs a field/, "Pick the custom field that starts it"],
	[/^trigger: unengaged needs days/, "Say how many days without an open or a click"],
	[/^trigger: link_clicked needs url/, "Give the address of the link that starts it, starting with https://"],
	[/^trigger: tag isn't a valid tag/, "The tag that starts it isn't a valid tag: letters, digits, spaces and - _ . : / + &"],
	[/^rules: /, "Fill in every condition of the branch"],
];

// The editor numbers steps from 1 and has no field names: "steps[2]: add_tag needs a tag" is the API's way of saying
// "Step 3 needs a tag", and "steps[0].paths[1].steps[2]: " is "Step 1, path 2, step 3: ".
function describePlace(place) {
	const parts = [...place.matchAll(/\[(\d+)\]/g)].map(([, index]) => Number(index) + 1);
	const labels = [`Step ${parts[0]}`];
	for (let index = 1; index < parts.length; index += 2) labels.push(`path ${parts[index]}`, `step ${parts[index + 1]}`);
	return labels.join(", ");
}

function toEditorError(failure) {
	if (failure.code !== "validation_failed") return toFormError(failure);
	const field = FIELD_ERRORS.find(([pattern]) => pattern.test(failure.message));
	if (field) return { error: field[1] };
	const message = failure.message
		.replace(/^(steps(?:\[\d+\]|\.paths|\.steps)+): (?:add_tag|remove_tag) needs a tag/, (_, place) => `${describePlace(place)} needs a tag`)
		.replace(/^(steps(?:\[\d+\]|\.paths|\.steps)+): /, (_, place) => `${describePlace(place)}: `);
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

// A draft from one of the templates (lib/automation-templates.js).
export async function createAutomationFromTemplate(newsletterId, template) {
	const { output, failure } = await runDashboardAction("create_automation_from_template", { newsletter: String(newsletterId ?? ""), template: String(template ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	redirect(`/automations/${output.id}`);
}

// Starts an active automation with a manual or API trigger for the addresses typed in, one on a line or separated by commas.
export async function enrollContacts(id, text) {
	const emails = String(text ?? "")
		.split(/[\s,;]+/)
		.map((email) => email.trim())
		.filter(Boolean);
	if (emails.length === 0) return { error: "Type at least one email address" };
	const { output, failure } = await runDashboardAction("enroll_contacts", { id: String(id), emails });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, ...output };
}

// The name alone while it's active; its trigger and steps too otherwise.
export async function saveAutomation(id, { name, trigger, steps }) {
	// The editor sends the tag field as it is; empty, the action reads it as a tag that isn't valid.
	if (["tag_added", "tag_removed"].includes(trigger?.type) && !String(trigger.tag ?? "").trim()) return { error: "Pick the tag that starts it" };
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
