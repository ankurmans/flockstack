import { scoped } from "./account-scope.js";
import { MANUAL_RUNS_PER_DAY } from "./briefing-rules.js";
import { getBriefingSlot } from "./briefing-schedule.js";
import BriefingRun from "../models/BriefingRun.js";

// Manual runs a briefing already had on the local day `now` falls on (its schedule's time zone). run_briefing refuses a request past
// MANUAL_RUNS_PER_DAY so the owner sees why, and the engine (lib/briefings/index.js) drops one that got in anyway.
export async function countManualRunsToday(briefing, now = new Date()) {
	const today = getBriefingSlot(briefing.schedule, now);
	const recent = await BriefingRun.find(scoped(briefing.accountId, { briefingId: briefing._id, isManual: true, createdAt: { $gte: new Date(now.getTime() - 2 * 24 * 60 * 60_000) } }))
		.select({ startedAt: 1, createdAt: 1 })
		.lean();
	return recent.filter((run) => getBriefingSlot(briefing.schedule, new Date(run.startedAt ?? run.createdAt)) === today).length;
}

export function isOverManualRuns(count) {
	return count >= MANUAL_RUNS_PER_DAY;
}
