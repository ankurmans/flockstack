"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
export async function archiveReply(formData) {
	const { failure } = await runDashboardAction("archive_reply", { id: String(formData.get("id") ?? ""), archived: formData.get("archived") === "true" });
	if (failure) redirect(`/replies?error=${encodeURIComponent(failure.message)}`);
	revalidatePath("/replies");
}
