import { expireAccountExports } from "@/lib/account-export";
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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour: PostShiba's word on whether FlockStack can send, Telegram's first message once it's set up, the account
// exports whose links ran out, the owners' digests of new comments and reports, the extra emails Polar hasn't been told
// about yet, dedicated IPs that no longer match their add-on, the day of every IP warm-up and the stock of spare IPs, the reminders to signups that haven't confirmed, and the
// Custom plan requests past their two years, the RSS feeds' kept copies nobody has read for a day, comps and gifts that ran out, and
// pledge charging whose job went quiet.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, ipWarmups, ipInventory, reminders, customRequests, feedCopies, grants, pledges, giftsSent, giftsExpired] = await Promise.all([
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
	]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, expiredExports, commentDigests, extraEmails, dedicatedIps, ipWarmups, ipInventory, reminders, customRequests, feedCopies, grants, pledges, giftsSent, giftsExpired })}`);
	return { postshiba, telegram };
});
