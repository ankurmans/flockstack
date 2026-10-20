import { NextResponse } from "next/server";
import { runGiftDeliveryStep } from "@/lib/gifts";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A gift's delivery day (lib/gifts.js): waits for the day, republishing itself when it is more than a few days away, then
// emails the recipient once. The hourly cron delivers any gift this job missed. A thrown error is retried by QStash.
async function handleDelivery(request) {
	const body = await request.json().catch(() => null);
	const result = await runGiftDeliveryStep({ accountId: body?.accountId, giftId: body?.giftId });
	console.info(`[gifts] ${JSON.stringify({ giftId: body?.giftId, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleDelivery);
