import { NextResponse } from "next/server";
import { runConversionStep } from "@/lib/pledge-conversion";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of "start charging" for a newsletter's pledges (lib/pledge-conversion.js); each step publishes the next. A step that
// finds another one still running answers 503, so QStash tries again later. A thrown error is retried too; the third one
// fails the conversion.
async function handleConversion(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, conversionId: body?.conversionId };
	const result = await runConversionStep(job);
	console.info(`[pledges] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleConversion);
