"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function result({ output, failure }) {
	if (failure) return toFormError(failure);
	revalidatePath("/recommending/creators", "layout");
	return { ok: true, output };
}
export async function saveCreatorSettings(_previous, data) {
	return result(await runDashboardAction("set_creator_match_settings", { newsletter: String(data.get("newsletter")), enabled: data.has("enabled"), topics: String(data.get("topics") || "").split(",").map((item) => item.trim()).filter(Boolean), emailNotifications: data.has("emailNotifications") }));
}
export async function sendIntroduction(_previous, data) {
	return result(await runDashboardAction("send_creator_intro", { newsletter: String(data.get("newsletter")), to: String(data.get("to")), body: String(data.get("body") || ""), externalId: String(data.get("externalId") || "") }));
}
export async function sendCreatorReply(_previous, data) {
	return result(await runDashboardAction("reply_creator_intro", { id: String(data.get("id")), body: String(data.get("body") || ""), externalId: String(data.get("externalId") || "") }));
}
export async function changeCreatorConversation(_previous, data) {
	return result(await runDashboardAction("set_creator_conversation", { id: String(data.get("id")), closed: data.get("closed") === "true" }));
}
