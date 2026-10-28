import { scoped } from "../account-scope.js";
import BriefingPublisher from "../../models/BriefingPublisher.js";
import BriefingRun from "../../models/BriefingRun.js";
import BriefingVerdict from "../../models/BriefingVerdict.js";

// What a briefing has learned: the owner's verdicts (with the title each story had, from its run) and its publishers' records.
const VERDICTS_READ = 500;

export async function loadVerdicts({ accountId, briefingId }) {
	const verdicts = await BriefingVerdict.find(scoped(accountId, { briefingId })).sort({ decidedAt: -1 }).limit(VERDICTS_READ).lean();
	const runIds = [...new Set(verdicts.map(({ runId }) => String(runId)))].slice(0, 100);
	const runs = runIds.length ? await BriefingRun.find(scoped(accountId, { _id: { $in: runIds } })).select({ stories: 1 }).lean() : [];
	const titles = new Map(runs.flatMap((run) => (run.stories ?? []).map((story) => [`${run._id}:${story.storyKey}`, story.title])));
	return verdicts.map((verdict) => ({
		verdict: verdict.verdict,
		features: verdict.features ?? null,
		url: verdict.url ?? "",
		title: titles.get(`${verdict.runId}:${verdict.storyKey}`) ?? "",
		decidedAt: verdict.decidedAt,
	}));
}

export async function loadPublishers({ accountId, briefingId, hosts }) {
	if (!hosts?.length) return new Map();
	const rows = [];
	for (let start = 0; start < hosts.length; start += 100) {
		rows.push(...(await BriefingPublisher.find(scoped(accountId, { briefingId, host: { $in: hosts.slice(start, start + 100) } })).lean()));
	}
	return new Map(rows.map((row) => [row.host, row]));
}

// Publishers whose stories were picked or kept, for their feeds.
export async function loadEarnedPublishers({ accountId, briefingId, limit = 20 }) {
	return BriefingPublisher.find(scoped(accountId, { briefingId, $or: [{ picked: { $gt: 0 } }, { kept: { $gt: 0 } }] }))
		.sort({ kept: -1, picked: -1 })
		.limit(limit)
		.lean();
}

// seen, shortlisted and picked counts per host for one run, and feeds found by autodiscovery ("" for none).
export async function recordPublishers({ accountId, briefingId, counts, feeds = {}, now }) {
	const hosts = new Set([...Object.keys(counts), ...Object.keys(feeds)]);
	for (const host of hosts) {
		const { seen = 0, shortlisted = 0, picked = 0 } = counts[host] ?? {};
		await BriefingPublisher.updateOne(
			scoped(accountId, { briefingId, host }),
			{ $inc: { seen, shortlisted, picked }, $set: { lastSeenAt: now, ...(host in feeds && { feedUrl: feeds[host] }) }, $setOnInsert: { firstSeenAt: now } },
			{ upsert: true }
		);
	}
}
