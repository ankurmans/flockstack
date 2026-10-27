"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
export async function findSendTime(newsletter, timeZone) {
	return runDashboardAction("get_best_send_time", { newsletter, timeZone });
}
