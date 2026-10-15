import { NextResponse } from "next/server";
import { runPurge } from "@/lib/account-purge";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Handled outcomes answer 200 so QStash doesn't retry them; a thrown error (database down) is retried.
async function handlePurge(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, purgeAt: body?.purgeAt };
	const result = await runPurge(job);
	console.info(`[purge] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handlePurge);
