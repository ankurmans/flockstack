import { expireAccountExports } from "@/lib/account-export";
import { announceTelegram } from "@/lib/alerts";
import { withCronSecret } from "@/lib/cron";
import { checkPostshibaStatus } from "@/lib/postshiba-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour: PostShiba's word on whether FlockStack can send, Telegram's first message once it's set up, and the account
// exports whose links ran out.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram, expiredExports] = await Promise.all([checkPostshibaStatus(), announceTelegram(), expireAccountExports()]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, expiredExports })}`);
	return { postshiba, telegram };
});
