import { NextResponse } from "next/server";
import { runAudioStep } from "@/lib/audio";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of an audio version (lib/audio.js): one part read in the voice and kept, or the parts joined. Each step
// publishes the next. A step that finds another one still running answers 503, so QStash tries again later; a thrown
// error is retried too, and the fourth in a row fails the job.
async function handleStep(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, audioId: body?.audioId };
	const result = await runAudioStep(job);
	console.info(`[audio] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleStep);
