import { NextResponse } from "next/server";
import { runAbTestPick } from "@/lib/ab-tests";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
async function handlePick(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId };
	const result = await runAbTestPick(job);
	console.info(`[ab-test] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handlePick);
