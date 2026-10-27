"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";
export async function saveMailingList(_state, form) {
	const id = String(form.get("id") ?? "");
	const { failure } = await runDashboardAction("upsert_mailing_list", { newsletter: String(form.get("newsletter")), ...(id && { id }), name: String(form.get("name") ?? ""), description: String(form.get("description") ?? ""), archived: form.get("archived") === "on" });
	if (failure) return { error: failure.message }; revalidatePath("/mailing-lists"); return { ok: true };
}
