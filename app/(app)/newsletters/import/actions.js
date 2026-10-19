"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function startImport(id) {
	const { output, failure } = await runDashboardAction("start_post_import", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	return { import: output };
}

export async function getImport(id) {
	const { output, failure } = await runDashboardAction("get_post_import", { id: String(id ?? "") });
	return failure ? toFormError(failure) : { import: output };
}
