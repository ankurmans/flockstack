"use server";
import { revalidatePath } from "next/cache";
import { runDashboardAction } from "@/lib/actions/dashboard";

export async function saveGroupSettings(_previous, form) {
	const result = await runDashboardAction("set_group_subscriptions", { id: String(form.get("newsletter")), enabled: form.get("enabled") === "on" });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/group-subscriptions"); return { ok: true };
}
export async function createCheckout(_previous, form) {
	const result = await runDashboardAction("create_group_checkout", { newsletter: String(form.get("newsletter")), email: String(form.get("email")), seats: Number(form.get("seats")), tierId: String(form.get("plan")).split(":")[0], option: String(form.get("plan")).split(":")[1], externalId: String(form.get("externalId")) });
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function refreshGroup(_previous, form) {
	const result = await runDashboardAction("refresh_group_subscription", { id: String(form.get("id")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath(`/group-subscriptions/${form.get("id")}`); return { ok: true };
}
export async function inviteSeat(_previous, form) {
	const result = await runDashboardAction("invite_group_seat", { id: String(form.get("id")), email: String(form.get("email")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath(`/group-subscriptions/${form.get("id")}`); return result.output.sent ? { ok: true, message: "Invitation sent" } : { error: "The seat is reserved, but its invitation couldn't be sent. Review sending settings before trying again." };
}
export async function revokeSeat(_previous, form) {
	const result = await runDashboardAction("revoke_group_seat", { id: String(form.get("id")), seatId: String(form.get("seatId")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath(`/group-subscriptions/${form.get("id")}`); return { ok: true, message: "Seat revoked" };
}
export async function emailManager(_previous, form) {
	const result = await runDashboardAction("send_group_manager_link", { id: String(form.get("id")), rotate: form.get("rotate") === "on" });
	if (result.failure) return { error: result.failure.message };
	return result.output.sent ? { ok: true, message: "Management email sent to the buyer" } : { error: "The management email couldn't be sent. Review sending settings before trying again." };
}
export async function readInvoices(id, after) {
	const result = await runDashboardAction("list_group_invoices", { id, ...(after && { after }) });
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function openGroupBilling(id) {
	const result = await runDashboardAction("open_group_billing_portal", { id });
	return result.failure ? { error: result.failure.message } : result.output;
}
