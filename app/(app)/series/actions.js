"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function refresh(id) {
	revalidatePath("/series");
	if (id) revalidatePath(`/series/${id}`);
}

// The form's values as the actions take them: the schedule's fields that apply to its frequency, whole numbers.
function readSeries(values) {
	const frequency = String(values?.frequency ?? "");
	return {
		name: String(values?.name ?? ""),
		feedUrl: String(values?.feedUrl ?? ""),
		schedule: {
			frequency,
			hour: Number(values?.hour),
			timeZone: String(values?.timeZone ?? "UTC"),
			...(frequency === "weekly" && { days: (Array.isArray(values?.days) ? values.days : []).map(Number) }),
			...(frequency === "monthly" && { dayOfMonth: Number(values?.dayOfMonth) }),
		},
		mode: values?.mode === "send" ? "send" : "draft",
		subject: String(values?.subject ?? ""),
		previewText: String(values?.previewText ?? ""),
		count: Number(values?.count),
		order: values?.order === "oldest" ? "oldest" : "newest",
		image: values?.image === true,
		excerpt: values?.excerpt === true,
		date: values?.date === true,
		...(typeof values?.intro === "string" && { intro: values.intro }),
		active: values?.active === true,
	};
}

export async function createSeries(newsletterId, values) {
	const { output, failure } = await runDashboardAction("create_series", { newsletter: String(newsletterId ?? ""), ...readSeries(values) });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.id };
}

export async function updateSeries(id, values) {
	const { failure } = await runDashboardAction("update_series", { id: String(id ?? ""), ...readSeries(values) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function deleteSeries(id) {
	const { failure } = await runDashboardAction("delete_series", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// A draft now from what the feed has that is new.
export async function runSeriesNow(id) {
	const { output, failure } = await runDashboardAction("run_series", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, run: output };
}
