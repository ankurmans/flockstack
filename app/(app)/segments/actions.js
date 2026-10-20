"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const RULE_ERRORS = [
	[/from is after to/, "A signup date range starts after it ends"],
	[/days is how many days back/, "Count engagement over 1 day or more"],
];

// The builder picks every condition's type and comparison, so what the rules refuse from it is a value left empty or
// out of range. The action's own words ("rules: tag: value is a tag") are the API's.
function toRulesError(failure, incomplete) {
	if (failure.code !== "validation_failed" || !failure.message.startsWith("rules: ")) return toFormError(failure);
	return { error: RULE_ERRORS.find(([pattern]) => pattern.test(failure.message))?.[1] ?? incomplete };
}

export async function createSegment({ newsletterId, name, description, rules }) {
	const { output, failure } = await runDashboardAction("create_segment", {
		newsletter: String(newsletterId ?? ""),
		name: String(name ?? ""),
		...(description && { description: String(description) }),
		rules,
	});
	if (failure) return toRulesError(failure, "Fill in every condition first");
	revalidatePath("/segments");
	return { ok: true, id: output.id };
}

// The contacts the rules match now, saved as a list that doesn't follow the newsletter.
export async function createSegmentList({ newsletterId, name, description, rules }) {
	const { output, failure } = await runDashboardAction("create_segment_snapshot", {
		newsletter: String(newsletterId ?? ""),
		name: String(name ?? ""),
		...(description && { description: String(description) }),
		rules,
	});
	if (failure) return toRulesError(failure, "Fill in every condition first");
	revalidatePath("/segments");
	return { ok: true, id: output.id, status: output.status };
}

// Rules are left out for a saved list, whose contacts can't change.
export async function updateSegment(id, { name, description, rules }) {
	const { failure } = await runDashboardAction("update_segment", {
		id: String(id),
		name: String(name ?? ""),
		description: description ? String(description) : null,
		...(rules && { rules }),
	});
	if (failure) return toRulesError(failure, "Fill in every condition first");
	revalidatePath("/segments");
	revalidatePath(`/segments/${id}`);
	return { ok: true };
}

export async function deleteSegment(id) {
	const { failure } = await runDashboardAction("delete_segment", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/segments");
	return { ok: true };
}

// Live counts for the builder's rules, as they are before saving.
export async function previewSegmentRules(newsletterId, rules) {
	const { output, failure } = await runDashboardAction("preview_segment", { newsletter: String(newsletterId ?? ""), rules, sample: 8 });
	return failure ? toRulesError(failure, "Fill in every condition to see who matches") : output;
}
