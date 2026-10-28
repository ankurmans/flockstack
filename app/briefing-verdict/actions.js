"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDeletionPending } from "@/lib/account-state";
import { verifyVerdictToken } from "@/lib/briefing-verdict-links";
import { recordVerdict } from "@/lib/briefing-verdicts";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import Account from "@/models/Account";

const PER_IP = { name: "briefing-verdict-ip", limit: 60, window: "10 m" };

// The confirmation page's button: the token comes back in the form, the same one the page was opened with. A link records only
// a story's first verdict; whatever happens, the page shows what is recorded now.
export async function confirmVerdict(formData) {
	const token = String(formData.get("token") ?? "");
	const page = `/briefing-verdict/${encodeURIComponent(token)}`;
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) redirect(`${page}?result=busy`);
	const link = verifyVerdictToken(token);
	if (!link) redirect(page);
	let result = "gone";
	try {
		await connectDb();
		const account = await Account.findById(link.accountId).lean();
		if (account && !isDeletionPending(account)) {
			const recorded = await recordVerdict({ account, runId: link.runId, storyKey: link.storyKey, verdict: link.verdict, linkId: link.linkId, decidedBy: "email-link" });
			result = recorded.status === "recorded" ? "recorded" : "already";
		}
	} catch (error) {
		if (error?.code !== "not_found") console.error("[briefing-verdict] Could not record:", error?.message);
	}
	redirect(`${page}?result=${result}`);
}
