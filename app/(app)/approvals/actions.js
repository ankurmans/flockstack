"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// Approve or reject what an agent asked to do. Approving runs it, once, as the key or app that asked.
export async function decideApproval(id, decision, note = "", acknowledgeChanges = false) {
	const { output, failure } = await runDashboardAction("decide_approval", {
		id: String(id),
		decision: decision === "approve" ? "approve" : "reject",
		note: String(note ?? "").slice(0, 500),
		acknowledgeChanges: acknowledgeChanges === true,
	});
	revalidatePath("/approvals");
	if (failure) return toFormError(failure);
	return { approval: output.approval, stale: output.stale };
}

export async function setAgentApproval(newsletter, required) {
	const { output, failure } = await runDashboardAction("set_agent_approval", { newsletter: String(newsletter), required: required === true });
	revalidatePath("/approvals");
	return failure ? toFormError(failure) : { required: output.required };
}
