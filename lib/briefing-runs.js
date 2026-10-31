import { scoped } from "./account-scope.js";
import { FREE_BRIEFINGS, MANUAL_RUNS_PER_DAY } from "./briefing-rules.js";
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

const DAY_MS = 24 * 60 * 60_000;

// On the Free plan (FREE_BRIEFINGS) a briefing runs weekly: when its next scheduled (or manual) run may start, or null when it may
// start now. run_briefing refuses a manual run before then, and the engine skips a scheduled slot or drops a manual run that comes
// too soon. The caller checks the account is on Free.
export async function nextFreeRunAt(briefing, { isManual, now = new Date() }) {
	const gap = (isManual ? FREE_BRIEFINGS.manualGapDays : FREE_BRIEFINGS.scheduledGapDays) * DAY_MS;
	const last = await BriefingRun.findOne(scoped(briefing.accountId, { briefingId: briefing._id, isManual, createdAt: { $gte: new Date(now.getTime() - gap) } }))
		.sort({ createdAt: -1 })
		.select({ createdAt: 1 })
		.lean();
	return last ? new Date(new Date(last.createdAt).getTime() + gap) : null;
}
