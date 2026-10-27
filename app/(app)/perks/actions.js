"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";
export async function savePerk(_state, form) {
	const id = String(form.get("id") ?? "");
	const { failure } = await runDashboardAction("upsert_subscriber_perk", { newsletter: String(form.get("newsletter")), ...(id && { id }), title: String(form.get("title")), description: String(form.get("description") ?? ""), url: String(form.get("url") ?? ""), code: String(form.get("code") ?? ""), productId: String(form.get("productId") ?? "") || null, tierId: String(form.get("tierId") ?? "") || null, archived: form.get("archived") === "on" });
	if (failure) return { error: failure.message }; revalidatePath("/perks"); return { ok: true };
}
