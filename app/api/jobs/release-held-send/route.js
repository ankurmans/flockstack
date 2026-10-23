import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";
import { runHeldRelease } from "@/lib/send-hold";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
async function handleRelease(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId, sendAfter: body?.sendAfter };
	const result = await runHeldRelease(job);
	console.info(`[held-send] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleRelease);
