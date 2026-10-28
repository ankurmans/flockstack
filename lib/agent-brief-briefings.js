import "server-only";
import { scoped } from "@/lib/account-scope";
import { DEFAULT_BUDGET_USD, DEFAULT_SCHEDULE, VERDICT_LINK_DAYS } from "@/lib/briefing-rules";
import { describeBriefingSchedule } from "@/lib/briefing-schedule";
import Briefing from "@/models/Briefing";
import BriefingRun from "@/models/BriefingRun";
import BriefingVerdict from "@/models/BriefingVerdict";
import Campaign from "@/models/Campaign";

// The briefings part of get_agent_brief (lib/agent-brief.js): each briefing's last few runs, its next run and what waits for the
// owner, short enough for an agent to read every time. The full runs are list_briefing_runs and get_briefing_run.
export const RUNS_PER_BRIEFING = 3;
const MAX_BRIEFINGS = 20;
const HELD = { review_mode: "for review", thin: "the run was thin", checks: "a check did not pass", partial: "part of the run did not finish", agent_approval: "the newsletter asks before an agent sends" };
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (value) => (value ? new Date(value).toISOString() : null);
const clip = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : (text ?? null));
const usd = (value) => `$${Number(value ?? 0).toFixed(2)}`;

// newsletterId: only that newsletter's briefings; null for the whole account.
export async function getBriefingsBrief(account, { newsletterId = null, now = new Date() } = {}) {
	const briefings = await Briefing.find(scoped(account, newsletterId ? { newsletterId } : {}))
		.select("newsletterId name status schedule budgetUsd nextRunAt manualRunAt")
		.sort({ createdAt: 1, _id: 1 })
		.limit(MAX_BRIEFINGS)
		.lean();
	if (briefings.length === 0) return [];
	const runLists = await Promise.all(
		briefings.map((briefing) =>
			BriefingRun.find(scoped(account, { briefingId: briefing._id }))
				.select("slot isManual status stage costUsd counts sections stories heldReason campaignId languages error createdAt finishedAt")
				.sort({ createdAt: -1, _id: -1 })
				.limit(RUNS_PER_BRIEFING)
				.lean()
		)
	);
	const runs = runLists.flat();
	const campaignIds = [...new Set(runs.map(({ campaignId }) => campaignId && String(campaignId)).filter(Boolean))];
	const [verdicts, campaigns] = await Promise.all([
		runs.length ? BriefingVerdict.find(scoped(account, { runId: { $in: runs.map(({ _id }) => _id) } })).select("runId storyKey").lean() : [],
		campaignIds.length ? Campaign.find(scoped(account, { _id: { $in: campaignIds } })).select("status").lean() : [],
	]);
	const rated = new Set(verdicts.map(({ runId, storyKey }) => `${runId}:${storyKey}`));
	const campaignStatus = new Map(campaigns.map(({ _id, status }) => [String(_id), status]));
	return briefings.map((briefing, index) => presentBriefing(briefing, runLists[index], { rated, campaignStatus, now }));
}

function presentBriefing(briefing, runs, { rated, campaignStatus, now }) {
	const budgetUsd = briefing.budgetUsd ?? DEFAULT_BUDGET_USD;
	const schedule = { days: briefing.schedule?.days?.length ? briefing.schedule.days : DEFAULT_SCHEDULE.days, time: briefing.schedule?.time ?? DEFAULT_SCHEDULE.time, timeZone: briefing.schedule?.timeZone || "UTC" };
	const shown = runs.map((run) => presentRun(run, { rated, campaignStatus, now }));
	const needsOwner = [];
	for (const run of shown) {
		if (run.draft === "waiting") needsOwner.push(`The ${run.slot} draft waits for review${run.held ? ` (held: ${HELD[run.held] ?? run.held})` : ""}: campaign ${run.campaignId}.`);
		if (run.verdictsPending > 0) needsOwner.push(`${run.verdictsPending} ${run.verdictsPending === 1 ? "story" : "stories"} of the ${run.slot} run have no keep or drop yet (rate_briefing_story).`);
		if (run.failedLanguages.length > 0) needsOwner.push(`The ${run.slot} run has no ${run.failedLanguages.map(({ language }) => language).join(", ")} translation (${run.failedLanguages.map(({ status }) => status).join(", ")}).`);
	}
	const [latest] = shown;
	if (latest?.status === "failed") needsOwner.push(`The last run failed${latest.error ? `: ${latest.error}` : ""}.`);
	if (latest?.status === "stopped_at_budget") needsOwner.push(`The last run stopped at its ${usd(budgetUsd)} cap: raise budgetUsd or narrow the briefing.`);
	return {
		id: String(briefing._id),
		newsletterId: String(briefing.newsletterId),
		name: briefing.name,
		status: briefing.status ?? "paused",
		schedule: describeBriefingSchedule(schedule),
		nextRunAt: briefing.status === "active" ? iso(briefing.nextRunAt) : null,
		manualRunAt: iso(briefing.manualRunAt),
		budgetUsd,
		runs: shown,
		needsOwner,
	};
}

function presentRun(run, { rated, campaignStatus, now }) {
	const status = run.status ?? "running";
	const finished = status === "drafted" || status === "sent";
	// The keep and drop links work for VERDICT_LINK_DAYS; after that the run page still takes a verdict, but nobody is waiting on one.
	const isRecent = now - new Date(run.createdAt ?? now).getTime() <= VERDICT_LINK_DAYS * DAY_MS;
	const stories = run.stories ?? [];
	const campaignId = run.campaignId ? String(run.campaignId) : null;
	const draftStatus = campaignId ? (campaignStatus.get(campaignId) ?? "deleted") : null;
	return {
		id: String(run._id),
		slot: run.slot,
		manual: Boolean(run.isManual),
		status,
		costUsd: Number(run.costUsd ?? 0),
		picked: run.counts?.picked ?? stories.length,
		...(run.sections?.length > 0 && { sections: run.sections.map(({ id, items, status: state }) => ({ id: id ?? "", items: items ?? 0, status: state ?? null })) }),
		held: run.heldReason ?? null,
		campaignId,
		draft: draftStatus === "draft" ? "waiting" : draftStatus,
		failedLanguages: (run.languages ?? []).filter(({ status: state }) => state && state !== "done" && (state !== "pending" || run.finishedAt)).map(({ language, status: state }) => ({ language: language ?? "", status: state })),
		verdictsPending: finished && isRecent ? stories.filter(({ storyKey }) => storyKey && !rated.has(`${run._id}:${storyKey}`)).length : 0,
		error: clip(run.error, 200),
	};
}
