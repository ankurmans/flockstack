import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried. The checker and the
// fetcher load only when a job comes in.
async function handleCheck(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, campaignId: body?.campaignId, hash: body?.hash };
	const { runClaimCheck } = await import("@/lib/claim-check-run");
	const result = await runClaimCheck(job);
	console.info(`[claim-check] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleCheck);
