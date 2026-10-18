import { NextResponse } from "next/server";
import { runExportStep } from "@/lib/account-export";
import { withQStashSignature } from "@/lib/qstash-route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One step of an account export (lib/account-export.js); each step publishes the next. A step that finds another one
// still running answers 503, so QStash tries again later. A thrown error is retried too; the third one fails the export.
async function handleExport(request) {
	const body = await request.json().catch(() => null);
	const job = { accountId: body?.accountId, exportId: body?.exportId };
	const result = await runExportStep(job);
	console.info(`[export] ${JSON.stringify({ ...job, ...result })}`);
	return NextResponse.json(result, { status: result.busy ? 503 : 200 });
}

export const POST = withQStashSignature(handleExport);
