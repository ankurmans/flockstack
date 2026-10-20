import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/config";
import { withQStashSignature } from "@/lib/qstash-route";
import { publishJob } from "@/lib/sending";
import { runDueSeries } from "@/lib/series";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// A QStash schedule calls this every 5 minutes (README: recurring series). A run that leaves series due asks for another one
// right away, one at a time.
async function handleRun() {
	const result = await runDueSeries();
	console.info(`[series] ${JSON.stringify(result)}`);
	if (result.hasMore) {
		await publishJob({
			url: `${getAppUrl()}/api/jobs/run-series`,
			body: { continued: true },
			flowControl: { key: "run-series", parallelism: 1 },
		}).catch((error) => console.error("[series] Could not ask for another run:", error.message));
	}
	return NextResponse.json(result);
}

export const POST = withQStashSignature(handleRun);
