"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDeletionPending } from "@/lib/account-state";
import { runAction } from "@/lib/actions/run-action";
import { verifyPauseToken } from "@/lib/briefing-pause-links";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import Account from "@/models/Account";

const PER_IP = { name: "briefing-pause-ip", limit: 30, window: "10 m" };

// The confirmation page's button: the token comes back in the form, the same one the page was opened with. Pausing a briefing that
// is already paused changes nothing, so a link can be pressed again.
export async function confirmPause(formData) {
	const token = String(formData.get("token") ?? "");
	const page = `/briefing-pause/${encodeURIComponent(token)}`;
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) redirect(`${page}?result=busy`);
	const link = verifyPauseToken(token);
	if (!link) redirect(page);
	let result = "gone";
	try {
		await connectDb();
		const account = await Account.findById(link.accountId).lean();
		if (account && !isDeletionPending(account)) {
			await runAction("pause_briefing", { account, input: { id: link.briefingId }, via: "briefing" });
			result = "paused";
		}
	} catch (error) {
		if (error?.code !== "not_found") console.error("[briefing-pause] Could not pause:", error?.message);
	}
	redirect(`${page}?result=${result}`);
}
