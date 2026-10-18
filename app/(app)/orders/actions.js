"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function resendOrder(id) {
	const { failure } = await runDashboardAction("resend_order_email", { id: String(id) });
	revalidatePath("/orders");
	return failure ? toFormError(failure) : { ok: true };
}
