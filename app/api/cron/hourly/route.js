import { announceTelegram } from "@/lib/alerts";
import { withCronSecret } from "@/lib/cron";
import { checkPostshibaStatus } from "@/lib/postshiba-status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour: PostShiba's word on whether FlockStack can send, and Telegram's first message once it's set up.
export const GET = withCronSecret(async () => {
	const [postshiba, telegram] = await Promise.all([checkPostshibaStatus(), announceTelegram()]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram })}`);
	return { postshiba, telegram };
});
