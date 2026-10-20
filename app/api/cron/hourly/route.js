import { expireAccountExports } from "@/lib/account-export";
import { announceTelegram } from "@/lib/alerts";
import { sendCommentDigests } from "@/lib/comment-notify";
import { sendConfirmationReminders } from "@/lib/confirmation-reminders";
import { withCronSecret } from "@/lib/cron";
import { purgeCustomRequests } from "@/lib/custom-requests";
import { followDedicatedIps } from "@/lib/dedicated-ip";
import { reportDueExtraEmails } from "@/lib/extra-emails";
import { checkPostshibaStatus } from "@/lib/postshiba-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour: PostShiba's word on whether FlockStack can send, Telegram's first message once it's set up, the account
// exports whose links ran out, the owners' digests of new comments and reports, the extra emails Polar hasn't been told
// about yet, dedicated IPs that no longer match their add-on, the reminders to signups that haven't confirmed, and the
// Custom plan requests past their two years.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, reminders, customRequests] = await Promise.all([
		checkPostshibaStatus(),
		announceTelegram(),
		expireAccountExports(),
		sendCommentDigests(),
		reportDueExtraEmails(),
		followDedicatedIps(),
		sendConfirmationReminders(),
		purgeCustomRequests(),
	]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, reminders, customRequests })}`);
	return { postshiba, telegram };
});
