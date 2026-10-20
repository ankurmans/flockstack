"use server";

import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// A report as CSV, with the filters the page shows it with: the same inputs as the report's own action.
export async function exportReport(input) {
	const { output, failure } = await runDashboardAction("export_report", {
		report: String(input?.report ?? ""),
		...(input?.table && { table: String(input.table) }),
		newsletter: String(input?.newsletter ?? ""),
		...(input?.days && { days: Number(input.days) }),
		...(input?.granularity && { granularity: String(input.granularity) }),
		...(input?.by && { by: String(input.by) }),
		...(input?.limit && { limit: Number(input.limit) }),
	});
	return failure ? toFormError(failure) : output;
}
