import { NextResponse } from "next/server";
import { withQStashSignature } from "@/lib/qstash-route";
import { runSnapshotStep } from "@/lib/segment-snapshots";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of saving a large segment as a list (lib/segment-snapshots.js); each step publishes the next. A step that finds
// another one still running answers 503, so QStash tries again later. A thrown error is retried from where the last page
// left off; the third one in a row fails the list.
async function handleSnapshot(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, segmentId: body?.segmentId };
	const result = await runSnapshotStep(job);
	console.info(`[snapshot-segment] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleSnapshot);
