"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { runDashboardAction } from "@/lib/actions/dashboard";
export async function switchWorkspace(formData) {
	const { failure } = await runDashboardAction("select_team_workspace", { id: String(formData.get("account") ?? "") });
	if (failure) redirect(`/team?error=${encodeURIComponent(failure.message)}`);
	revalidatePath("/", "layout"); redirect("/team");
}
export async function acceptInvite(formData) {
	const { failure } = await runDashboardAction("accept_team_invitation", { id: String(formData.get("id") ?? "") });
	if (failure) redirect(`/team?error=${encodeURIComponent(failure.message)}`);
	revalidatePath("/", "layout"); redirect("/team");
}
export async function inviteMember(formData) {
	const { failure } = await runDashboardAction("invite_team_member", { email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "") });
	if (failure) redirect(`/team?error=${encodeURIComponent(failure.message)}`);
	revalidatePath("/team");
}
export async function changeMember(formData) {
	const { failure } = await runDashboardAction("update_team_member", { id: String(formData.get("id") ?? ""), role: String(formData.get("role") ?? ""), remove: formData.get("remove") === "true" });
	if (failure) redirect(`/team?error=${encodeURIComponent(failure.message)}`);
	revalidatePath("/team");
}
