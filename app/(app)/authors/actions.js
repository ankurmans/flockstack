"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { revalidatePath } from "next/cache";
export async function saveAuthor(_state, form) {
	const newsletter = String(form.get("newsletter") ?? "");
	const id = String(form.get("id") ?? "");
	const archiving = form.has("archived");
	const result = archiving
		? await runDashboardAction("archive_newsletter_author", { newsletter, id, archived: form.get("archived") === "true" })
		: await runDashboardAction("upsert_newsletter_author", { newsletter, ...(id && { id }), name: String(form.get("name") ?? ""), bio: String(form.get("bio") ?? ""), imageUrl: String(form.get("imageUrl") ?? "") });
	if (result.failure) return { error: result.failure.message };
	revalidatePath("/authors"); return { ok: true };
}
export async function chooseIssueAuthor(_state, form) {
	const id = String(form.get("campaign"));
	const current = await runDashboardAction("get_campaign", { id });
	if (current.failure) return { error: current.failure.message };
	const result = ["draft", "scheduled"].includes(current.output.status)
		? await runDashboardAction("update_campaign", { id, authorId: String(form.get("author")) })
		: await runDashboardAction("set_campaign_author", { id, authorId: String(form.get("author")) });
	if (result.failure) return { error: result.failure.message };
	revalidatePath(`/campaigns/${String(form.get("campaign"))}`); return { ok: true };
}
export async function previewReader(_state, form) {
	const kind = String(form.get("reader"));
	const { output, failure } = await runDashboardAction("preview_campaign_as_reader", { id: String(form.get("campaign")), mode: String(form.get("mode")), ...(kind === "subscriber" ? { email: String(form.get("email")) } : { tier: kind }) });
	return failure ? { error: failure.message } : output;
}
