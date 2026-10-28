import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { hostOf } from "@/lib/briefings/urls";
import { isObjectIdString } from "@/lib/validation";
import BriefingPublisher from "@/models/BriefingPublisher";
import BriefingRun from "@/models/BriefingRun";
import BriefingVerdict from "@/models/BriefingVerdict";

// The owner's keep or drop on a story a briefing run found (models/BriefingVerdict.js), from the dashboard and the API
// (rate_briefing_story) or from a link in the owner's note (app/briefing-verdict). Each verdict keeps the features the ranker saw, so
// a refit needs no run, and counts once for the story's publisher (models/BriefingPublisher.js).

// The run's story and what the ranker saw: the engine keeps features on the story; a run still going may have them in its work.
export async function findRunStory(account, runId, storyKey) {
	const run = isObjectIdString(String(runId)) ? await BriefingRun.findOne(scoped(account, { _id: runId })).select({ briefingId: 1, stories: 1, "work.features": 1 }).lean() : null;
	if (!run) throw actionError("not_found", "Run not found");
	const story = (run.stories ?? []).find((one) => one.storyKey === storyKey);
	if (!story) throw actionError("not_found", "That story isn't in this run");
	return { run, story, features: story.features ?? run.work?.features?.[storyKey] ?? null };
}

async function countForPublisher(account, briefingId, url, changes, now) {
	const host = hostOf(url);
	if (!host) return;
	await BriefingPublisher.updateOne(
		scoped(account, { briefingId, host }),
		{ $inc: changes, $setOnInsert: { firstSeenAt: now } },
		{ upsert: true }
	);
}

const COUNTER = { keep: "kept", drop: "dropped" };

// Records the verdict. linkId: the email link it came from, which records only a story's first verdict ("already", with the verdict
// there is, when it has one). Without one, a new verdict replaces the old and the publisher's counts move with it.
export async function recordVerdict({ account, runId, storyKey, verdict, linkId = null, decidedBy = null, now = new Date() }) {
	const { run, story, features } = await findRunStory(account, runId, storyKey);
	const filter = scoped(account, { briefingId: run.briefingId, runId: run._id, storyKey });
	const existing = await BriefingVerdict.findOne(filter).select({ verdict: 1, decidedAt: 1 }).lean();
	if (existing && (linkId || existing.verdict === verdict)) return { status: linkId ? "already" : "same", verdict: existing.verdict, decidedAt: existing.decidedAt, story };
	if (existing) {
		const { modifiedCount } = await BriefingVerdict.updateOne({ ...filter, verdict: existing.verdict }, { $set: { verdict, decidedAt: now, ...(decidedBy && { decidedBy }), ...(features && { features }) } });
		if (modifiedCount) await countForPublisher(account, run.briefingId, story.url, { [COUNTER[existing.verdict]]: -1, [COUNTER[verdict]]: 1 }, now);
		return { status: "changed", verdict, decidedAt: now, story };
	}
	try {
		await BriefingVerdict.create({
			accountId: account._id ?? account,
			briefingId: run.briefingId,
			runId: run._id,
			storyKey,
			...(story.url && { url: story.url }),
			verdict,
			...(features && { features }),
			...(linkId && { linkId }),
			...(decidedBy && { decidedBy }),
			decidedAt: now,
		});
	} catch (error) {
		// Two presses at once, or the same link twice: the unique indexes let one through.
		if (error?.code !== 11000) throw error;
		const winner = await BriefingVerdict.findOne(filter).select({ verdict: 1, decidedAt: 1 }).lean();
		return { status: "already", verdict: winner?.verdict ?? verdict, decidedAt: winner?.decidedAt ?? now, story };
	}
	await countForPublisher(account, run.briefingId, story.url, { [COUNTER[verdict]]: 1 }, now);
	return { status: "recorded", verdict, decidedAt: now, story };
}
