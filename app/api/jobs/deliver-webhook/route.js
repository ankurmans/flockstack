import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";
import { deliverWebhook } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One attempt of one webhook delivery. A failing endpoint is handled here (the next attempt is its own job, later), so it
// answers 200; only a thrown error (database down) makes QStash run the attempt again.
async function handleDelivery(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, deliveryId: body?.deliveryId, attempt: body?.attempt };
	const result = await deliverWebhook(job);
	console.info(`[webhooks] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleDelivery);
