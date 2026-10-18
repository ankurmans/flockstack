"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function createSegment({ newsletterId, name, description, rules }) {
	const { output, failure } = await runDashboardAction("create_segment", {
		newsletter: String(newsletterId ?? ""),
		name: String(name ?? ""),
		...(description && { description: String(description) }),
		rules,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/segments");
	return { ok: true, id: output.id };
}

export async function updateSegment(id, { name, description, rules }) {
	const { failure } = await runDashboardAction("update_segment", {
		id: String(id),
		name: String(name ?? ""),
		description: description ? String(description) : null,
		rules,
	});
	if (failure) return toFormError(failure);
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
	return failure ? toFormError(failure) : output;
}
