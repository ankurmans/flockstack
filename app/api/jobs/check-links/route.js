import { NextResponse } from "next/server";
import { runLinkCheck } from "@/lib/link-check";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
async function handleCheck(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId, hash: body?.hash };
	const result = await runLinkCheck(job);
	console.info(`[link-check] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleCheck);
