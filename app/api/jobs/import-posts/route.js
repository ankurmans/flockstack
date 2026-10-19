import { NextResponse } from "next/server";
import { runImportStep } from "@/lib/post-import";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of a post import (lib/post-import.js); each step publishes the next. A step that finds another one still
// running answers 503, so QStash tries again later. A thrown error is retried too; the third one fails the import.
async function handleImport(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, importId: body?.importId };
	const result = await runImportStep(job);
	console.info(`[post-import] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleImport);
