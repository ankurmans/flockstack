import { expireAccountExports } from "@/lib/account-export";
import { announceTelegram } from "@/lib/alerts";
import { sendCommentDigests } from "@/lib/comment-notify";
import { withCronSecret } from "@/lib/cron";
import { checkPostshibaStatus } from "@/lib/postshiba-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour: PostShiba's word on whether FlockStack can send, Telegram's first message once it's set up, the account
// exports whose links ran out, and the owners' digests of new comments and reports.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram, expiredExports, commentDigests] = await Promise.all([
		checkPostshibaStatus(),
		announceTelegram(),
		expireAccountExports(),
		sendCommentDigests(),
	]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, expiredExports, commentDigests })}`);
	return { postshiba, telegram };
});
