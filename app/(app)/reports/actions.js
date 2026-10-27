"use server";

import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";

// A report as CSV, with the filters the page shows it with: the same inputs as the report's own action.
export async function exportReport(input) {
	if (input?.report === "revenue") {
		const { output, failure } = await runDashboardAction("export_subscription_revenue_report", { newsletter: String(input.newsletter ?? ""), ...(input.days && { days: Number(input.days) }) });
		return failure ? toFormError(failure) : output;
	}
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

export async function refreshRevenue(_previous, data) {
	const { output, failure } = await runDashboardAction("refresh_subscription_revenue", { newsletter: String(data.get("newsletter") ?? ""), ...(data.get("cursor") && { cursor: String(data.get("cursor")) }) });
	if (failure) return toFormError(failure);
	revalidatePath("/reports/revenue");
	return { ok: true, ...output };
}
