import { withCronSecret } from "@/lib/cron";
import { checkPostmaster } from "@/lib/postmaster";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every day: Gmail's spam rates from Google Postmaster Tools (lib/postmaster.js).
export const GET = withCronSecret(async () => {
	const postmaster = await checkPostmaster();
	console.info(`[postmaster] ${JSON.stringify({ postmaster })}`);
	return { postmaster };
});
