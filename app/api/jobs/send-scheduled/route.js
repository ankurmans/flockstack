import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";
import { runScheduledSend } from "@/lib/scheduling";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
// Each outcome is logged: it's the trace of when and why a scheduled issue went out or didn't.
async function handleScheduled(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId, scheduledAt: body?.scheduledAt };
	const result = await runScheduledSend(job);
	console.info(`[scheduled] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleScheduled);
