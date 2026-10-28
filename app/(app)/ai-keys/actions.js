"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The key goes to add_ai_key and nowhere else: the answer has its last four characters only.
export async function addAiKey(values) {
	const provider = String(values?.provider ?? "");
	const { output, failure } = await runDashboardAction("add_ai_key", {
		name: String(values?.name ?? "").slice(0, 60),
		provider,
		key: String(values?.key ?? ""),
		...((provider === "openai-compatible" || provider === "candidate-feed") && { baseUrl: String(values?.baseUrl ?? "") }),
		...(provider === "cloudflare" && { accountRef: String(values?.accountRef ?? "") }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/ai-keys");
	return { ok: true, hint: output.hint };
}

export async function checkAiKey(id) {
	const { output, failure } = await runDashboardAction("check_ai_key", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/ai-keys");
	return { ok: true, status: output.key.status, problem: output.problem };
}

export async function deleteAiKey(id) {
	const { failure } = await runDashboardAction("delete_ai_key", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/ai-keys");
	return { ok: true };
}
