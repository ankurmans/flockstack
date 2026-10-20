import { NextResponse } from "next/server";
import { runRemovalStep } from "@/lib/bulk-removal";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of taking a deleted tag or field off a large list (lib/bulk-removal.js); each step publishes the next. A step
// that finds another one still running answers 503, so QStash tries again later. A thrown error is retried from where the
// last chunk left off; the third one in a row fails the removal.
async function handleRemoval(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, removalId: body?.removalId };
	const result = await runRemovalStep(job);
	console.info(`[remove-from-contacts] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleRemoval);
