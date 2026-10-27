"use server";

import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function createAssistantGrant(newsletter, level) {
	const { output, failure } = await runDashboardAction("create_assistant_grant", { newsletter: String(newsletter), level: String(level) });
	return failure ? toFormError(failure) : output;
}

export async function askAccountAssistant(input) {
	const { output, failure } = await runDashboardAction("chat_with_assistant", input);
	return failure ? toFormError(failure) : output;
}
