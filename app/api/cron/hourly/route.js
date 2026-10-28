import { expireCollaborationSnapshots } from "@/lib/editor-housekeeping";
import { expireAccountExports } from "@/lib/account-export";
import { runAgentHousekeeping } from "@/lib/agent-housekeeping";
import { announceTelegram } from "@/lib/alerts";
import { sendCommentDigests } from "@/lib/comment-notify";
import { sendConfirmationReminders } from "@/lib/confirmation-reminders";
import { withCronSecret } from "@/lib/cron";
import { purgeCustomRequests } from "@/lib/custom-requests";
import { followDedicatedIps } from "@/lib/dedicated-ip";
import { checkInventoryLevel } from "@/lib/ip-inventory";
import { advanceIpWarmups } from "@/lib/ip-warmup";
import { reportDueExtraEmails } from "@/lib/extra-emails";
import { deliverDueGifts, expireGifts } from "@/lib/gifts";
import { expireGrants } from "@/lib/grant-access";
import { resumeConversions } from "@/lib/pledge-conversion";
import { purgeOldFeeds } from "@/lib/feed-fetch";
import { checkPostshibaStatus } from "@/lib/postshiba-status";
import { purgeOldLinkChecks } from "@/lib/link-check";
import { sweepHeldSends } from "@/lib/send-hold";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How long a self-hosted tick of the briefings engine may start stages for, inside this route's minute.
const BRIEFINGS_BUDGET_MS = 40_000;

// A self-hosted server runs briefings here (BRIEFINGS_IN_CRON=true) instead of in the optional briefings Worker, once an hour. FlockStack
// Cloud has the Worker: in its build (FLOCKSTACK_CLOUD_BUILD, a constant there) the branch is dead, so the engine stays out of the app's bundle,
// and elsewhere it loads only when switched on. No fetchImpl: on Node the engine's own checks each address as it connects.
async function runBriefingsInCron() {
	if (process.env.FLOCKSTACK_CLOUD_BUILD !== "true" && process.env.BRIEFINGS_IN_CRON === "true") {
		try {
			const [{ runTick }, { deliverIssue, notifyOwner }] = await Promise.all([import("@/lib/briefings"), import("@/lib/briefings-delivery")]);
			return await runTick({ env: process.env, now: new Date(), delivery: { deliverIssue, notifyOwner }, timeBudgetMs: BRIEFINGS_BUDGET_MS, ai: null });
		} catch (error) {
			console.error("[hourly] briefings failed:", error?.message ?? error);
			return { failed: error?.message ?? "failed" };
		}
	}
	return null;
}

// Every hour: PostShiba's word on whether FlockStack can send, Telegram's first message once it's set up, the account
// exports whose links ran out, the owners' digests of new comments and reports, the extra emails Polar hasn't been told
// about yet, dedicated IPs that no longer match their add-on, the day of every IP warm-up and the stock of spare IPs, the reminders to signups that haven't confirmed, and the
// Custom plan requests past their two years, the RSS feeds' kept copies nobody has read for a day, comps and gifts that ran out, and
// pledge charging whose job went quiet, and the agent approvals nobody decided and the agent activity past its 90 days, the held sends whose release job never ran, and the link checks nobody looked at for a week.
// On a self-hosted server with BRIEFINGS_IN_CRON=true, also a tick of the briefings engine.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, ipWarmups, ipInventory, reminders, customRequests, feedCopies, grants, pledges, giftsSent, giftsExpired, agentRecords, heldSends, linkChecks, editorSnapshots, briefings] = await Promise.all([
		checkPostshibaStatus(),
		announceTelegram(),
		expireAccountExports(),
		sendCommentDigests(),
		reportDueExtraEmails(),
		followDedicatedIps(),
		advanceIpWarmups(),
		checkInventoryLevel(),
		sendConfirmationReminders(),
		purgeCustomRequests(),
		purgeOldFeeds(),
		expireGrants(),
		resumeConversions(),
		deliverDueGifts(),
		expireGifts(),
		runAgentHousekeeping(),
		sweepHeldSends(),
		purgeOldLinkChecks(),
		expireCollaborationSnapshots(),
		runBriefingsInCron(),
	]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, ipWarmups, ipInventory, reminders, customRequests, feedCopies, grants, pledges, giftsSent, giftsExpired, agentRecords, heldSends, linkChecks, editorSnapshots, briefings })}`);
	return { postshiba, telegram };
});
