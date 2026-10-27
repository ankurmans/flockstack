"use server";
import { revalidatePath } from "next/cache";
import { runDashboardAction } from "@/lib/actions/dashboard";

export async function refresh(_previous, form) {
	const result = await runDashboardAction("refresh_reader_billing", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function pause(_previous, form) {
	const result = await runDashboardAction("schedule_reader_pause", { id: String(form.get("id")), externalId: String(form.get("externalId")), months: Number(form.get("months")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function unpause(_previous, form) {
	const result = await runDashboardAction("cancel_reader_pause", { id: String(form.get("id")), externalId: String(form.get("externalId")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function resume(_previous, form) {
	const result = await runDashboardAction("resume_reader_subscription", { id: String(form.get("id")), externalId: String(form.get("externalId")), confirmBilling: form.get("confirm") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function save(_previous, form) {
	const result = await runDashboardAction("accept_reader_save_offer", { id: String(form.get("id")), externalId: String(form.get("externalId")), offerId: String(form.get("offerId")), expectedHash: String(form.get("expectedHash")), confirm: form.get("confirm") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function cancel(_previous, form) {
	const result = await runDashboardAction("cancel_reader_subscription", { id: String(form.get("id")), externalId: String(form.get("externalId")), confirm: form.get("confirm") === "on", response: { reason: String(form.get("reason") ?? "") || null, comment: String(form.get("comment") ?? ""), shareWithCreator: form.get("shareWithCreator") === "on" } });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
export async function settings(_previous, form) {
	const result = await runDashboardAction("set_reader_retention_settings", { id: String(form.get("newsletter")), pauseEnabled: form.get("pauseEnabled") === "on", surveyEnabled: form.get("surveyEnabled") === "on", saveOfferId: String(form.get("saveOfferId") ?? "") || null, confirmFlexibleBilling: form.get("confirmFlexibleBilling") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/reader-billing");
	return { ok: true, output: result.output };
}
