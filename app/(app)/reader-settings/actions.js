"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";
export async function saveReaderSettings(_state, formData) {
	const result = await runDashboardAction("update_reader_settings", { newsletter: String(formData.get("newsletter")), language: String(formData.get("language")), meteredReadsPerMonth: Number(formData.get("meteredReadsPerMonth") ?? 0), readerTranslations: formData.get("readerTranslations") === "on", replyInbox: formData.get("replyInbox") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-settings"); return { ok: true };
}
