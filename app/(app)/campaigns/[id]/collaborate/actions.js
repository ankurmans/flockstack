"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
export async function connectCampaign(id) {
	const result = await runDashboardAction("open_campaign_collaboration", { id });
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function readThreads(id, cursor = null) {
	const result = await runDashboardAction("list_editor_threads", { id, ...(cursor && { cursor }) });
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function addThread(input) {
	const result = await runDashboardAction("create_editor_thread", input);
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function replyThread(input) {
	const result = await runDashboardAction("reply_editor_thread", input);
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function resolveThread(input) {
	const result = await runDashboardAction("resolve_editor_thread", input);
	return result.failure ? { error: result.failure.message } : result.output;
}
export async function removeThread(input) {
	const result = await runDashboardAction("remove_editor_thread", input);
	return result.failure ? { error: result.failure.message } : result.output;
}
