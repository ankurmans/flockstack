import { NextResponse } from "next/server";
import { runAutomations } from "@/lib/automations";
import { getAppUrl } from "@/lib/config";
import { withQStashSignature } from "@/lib/qstash-route";
import { publishJob } from "@/lib/sending";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// A QStash schedule calls this every few minutes (README: automations). A run that leaves enrollments due asks for another
// one right away, one at a time, so a big list moves along without waiting for the schedule.
async function handleRun() {
	const result = await runAutomations();
	console.info(`[automations] ${JSON.stringify(result)}`);
	if (result.hasMore) {
		await publishJob({
			url: `${getAppUrl()}/api/jobs/run-automations`,
			body: { continued: true },
			flowControl: { key: "run-automations", parallelism: 1 },
		}).catch((error) => console.error("[automations] Could not ask for another run:", error.message));
	}
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleRun);
