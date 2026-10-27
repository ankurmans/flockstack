"use server";
import { revalidatePath } from "next/cache";
import { runDashboardAction } from "@/lib/actions/dashboard";

export async function saveSettings(_previous, form) {
	const result = await runDashboardAction("set_sponsorship_settings", { id: String(form.get("newsletter")), enabled: form.get("enabled") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function savePlacement(_previous, form) {
	const result = await runDashboardAction("save_sponsorship_placement", { newsletter: String(form.get("newsletter")), ...(form.get("placementId") && { placementId: String(form.get("placementId")) }), name: String(form.get("name")), description: String(form.get("description") ?? ""), amountMinor: Number(form.get("amountMinor")), currency: String(form.get("currency")), archived: form.get("archived") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function saveSlot(_previous, form) {
	const result = await runDashboardAction("save_sponsorship_slot", { newsletter: String(form.get("newsletter")), placementId: String(form.get("placementId")), day: String(form.get("day")), timeZone: String(form.get("timeZone")), open: form.get("open") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function acceptBooking(_previous, form) {
	const result = await runDashboardAction("accept_sponsorship_booking", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function createInvoice(_previous, form) {
	const result = await runDashboardAction("create_sponsorship_invoice", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true, url: result.output.hostedUrl };
}
export async function refreshInvoice(_previous, form) {
	const result = await runDashboardAction("refresh_sponsorship_invoice", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true, url: result.output.hostedUrl };
}
export async function emailInvoice(_previous, form) {
	const result = await runDashboardAction("email_sponsorship_invoice", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return result.output.sent ? { ok: true, message: "Email accepted by the provider" } : { error: "The email could not be sent. Review sending settings before retrying." };
}
export async function emailManager(_previous, form) {
	const result = await runDashboardAction("email_sponsorship_manager", { id: String(form.get("id")), rotate: form.get("rotate") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return result.output.sent ? { ok: true, message: "Email accepted by the provider" } : { error: "The email could not be sent. Review sending settings before retrying." };
}
export async function cancelBooking(_previous, form) {
	const result = await runDashboardAction("cancel_sponsorship_booking", { id: String(form.get("id")), acknowledgeNoRefund: form.get("acknowledgeNoRefund") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function saveCreative(_previous, form) {
	const result = await runDashboardAction("update_sponsorship_creative", { id: String(form.get("id")), creative: { headline: String(form.get("headline")), body: String(form.get("body")), callToAction: String(form.get("callToAction")), url: String(form.get("url")), assetId: String(form.get("assetId") ?? "") || null } });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function approveCreative(_previous, form) {
	const result = await runDashboardAction("approve_sponsorship_creative", { id: String(form.get("id")), expectedHash: String(form.get("expectedHash")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function detachBooking(_previous, form) {
	const result = await runDashboardAction("detach_sponsorship_booking", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function previewImage(_previous, form) {
	const result = await runDashboardAction("preview_sponsorship_asset", { id: String(form.get("id")), assetId: String(form.get("assetId")) });
	if (result.failure) return { error: result.failure.message };
	return { dataUrl: result.output.dataUrl };
}
export async function removeImage(_previous, form) {
	const result = await runDashboardAction("remove_sponsorship_asset", { id: String(form.get("id")), assetId: String(form.get("assetId")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/sponsorships");
	if (form.get("id")) revalidatePath(`/sponsorships/${form.get("id")}`);
	return { ok: true };
}
export async function prepareSponsorBlock(input) {
	const result = await runDashboardAction("prepare_sponsorship_block", input);
	return result.failure ? { error: result.failure.message } : result.output;
}
