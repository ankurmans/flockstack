"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function setActivityRetention(days) {
	const { output, failure } = await runDashboardAction("set_agent_activity_retention", { days: Number(days) });
	revalidatePath("/agent-activity");
	return failure ? toFormError(failure) : { days: output.days };
}
