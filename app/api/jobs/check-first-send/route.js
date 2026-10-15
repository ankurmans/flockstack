import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";
import { checkFirstSend } from "@/lib/sending";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
async function handleCheck(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId };
	const result = await checkFirstSend(job);
	console.info(`[first-send] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleCheck);
