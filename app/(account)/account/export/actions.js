"use server";

import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function startExport() {
	const { output, failure } = await runDashboardAction("export_account_data", {});
	return failure ? toFormError(failure) : { export: output };
}

export async function getExportStatus() {
	const { output, failure } = await runDashboardAction("get_account_export", {});
	return failure ? toFormError(failure) : { export: output };
}
