"use server";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
export async function previewWorkspace(id, token) {
	const { output, failure } = await runDashboardAction("preview_agent_workspace", { id, token });
	return failure ? toFormError(failure) : output;
}
export async function claimWorkspace(_state, formData) {
	const { output, failure } = await runDashboardAction("claim_agent_workspace", { id: String(formData.get("id")), token: String(formData.get("token")), revision: Number(formData.get("revision")) });
	return failure ? toFormError(failure) : { ok: true, reviewUrl: output.reviewUrl };
}
