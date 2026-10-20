import "server-only";
import { scoped } from "@/lib/account-scope";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { ObjectId } from "@/lib/docdb";
import { BULK_LIMITS } from "@/lib/docdb/model";
import { insertIgnoringDuplicates } from "@/lib/insert-ignoring-duplicates";
import { getSegmentFilter } from "@/lib/segments";
import { publishJob } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Segment from "@/models/Segment";
import SegmentMember from "@/models/SegmentMember";

// A saved list (a static segment) is the contacts some rules matched when it was saved. A small one is written in the
// request; past `inline` contacts it fills in over jobs, a page of contacts at a time (as lib/bulk-removal.js does), each
// job working for a while and then publishing the next. Tests lower these.
export const SNAPSHOT_LIMITS = { inline: 20_000, chunk: BULK_LIMITS.scanPage };
const LOCK_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
// A build no step has touched for this long lost its job: the next look at the list publishes another.
const STALE_MS = 5 * 60_000;

// SNAPSHOT_STEP_MS shortens a step, to one page per job in tests.
function getStepMs() {
	return process.env.SNAPSHOT_STEP_MS ? Number(process.env.SNAPSHOT_STEP_MS) : 20_000;
}

export function getSnapshotJobUrl() {
	return `${getAppUrl()}/api/jobs/snapshot-segment`;
}

function publishStep(accountId, segmentId) {
	return publishJob({ url: getSnapshotJobUrl(), body: { accountId: String(accountId), segmentId: String(segmentId) } });
}

// The rules of a saved list: the one condition "on this list".
export function getSnapshotRules(segmentId, name) {
	return { match: "all", conditions: [{ type: "snapshot", segment: String(segmentId), name }] };
}

// Saves the contacts the rules match now as a list of the newsletter. Returns the segment, which is already ready when
// the list was small.
export async function createSnapshot(account, { newsletterId, name, description, rules, now = new Date() }) {
	const filter = await getSegmentFilter(account, newsletterId, rules, now);
	const total = await Contact.countDocuments(filter);
	const id = new ObjectId();
	await Segment.create({
		_id: id,
		accountId: scoped(account).accountId,
		newsletterId,
		name,
		...(description && { description }),
		kind: "static",
		rules: getSnapshotRules(id, name),
		snapshotRules: rules,
		snapshotTotal: total,
		snapshotAt: now,
		buildStatus: "building",
	});
	const accountId = scoped(account).accountId;
	if (total <= SNAPSHOT_LIMITS.inline) {
		await runSnapshotStep({ accountId, segmentId: id }, { untilMs: Number.POSITIVE_INFINITY });
	} else {
		try {
			await publishStep(accountId, id);
		} catch (error) {
			await Segment.updateOne(scoped(account, { _id: id }), { $set: { buildStatus: "failed", buildError: "The job queue didn't take it" } });
			throw error;
		}
	}
	return Segment.findOne(scoped(account, { _id: id })).lean();
}

// One job: claims the list, writes a page of contacts after the cursor at a time, saving the cursor after each, until its
// time is up, then publishes the next job. A page written twice changes nothing (one row per contact). A step that throws is
// tried again by QStash from the saved cursor; the third time in a row, the list fails.
export async function runSnapshotStep({ accountId, segmentId }, { untilMs = getStepMs() } = {}) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(segmentId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await Segment.findOneAndUpdate(
		scoped(accountId, { _id: segmentId, buildStatus: "building", $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }),
		{ $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) {
		const current = await Segment.findOne(scoped(accountId, { _id: segmentId })).select({ buildStatus: 1 }).lean();
		return current?.buildStatus === "building" ? { busy: true } : { skipped: current?.buildStatus ?? "not found" };
	}

	const until = Date.now() + untilMs;
	let cursor = claimed.buildCursor ?? null;
	try {
		const filter = await getSegmentFilter(accountId, claimed.newsletterId, claimed.snapshotRules, claimed.snapshotAt);
		for (;;) {
			const page = await Contact.find({ ...filter, ...(cursor && { _id: { $gt: cursor } }) })
				.sort({ _id: 1 })
				.limit(SNAPSHOT_LIMITS.chunk)
				.select({ _id: 1 })
				.lean();
			if (page.length === 0) {
				const memberCount = await SegmentMember.countDocuments(scoped(accountId, { segmentId: claimed._id }));
				await Segment.updateOne(scoped(accountId, { _id: claimed._id }), {
					$set: { buildStatus: "ready", memberCount, buildAttempts: 0 },
					$unset: { lockedUntil: 1, buildCursor: 1, snapshotRules: 1 },
				});
				return { done: true, members: memberCount };
			}
			await insertIgnoringDuplicates(
				SegmentMember,
				page.map(({ _id }) => ({ accountId, segmentId: claimed._id, contactId: _id }))
			);
			cursor = String(page.at(-1)._id);
			await Segment.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { buildCursor: cursor } });
			if (Date.now() >= until) break;
		}
		await Segment.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { buildAttempts: 0 }, $unset: { lockedUntil: 1 } });
		await publishStep(accountId, claimed._id);
		return { continued: true };
	} catch (error) {
		const attempts = (claimed.buildAttempts ?? 0) + 1;
		if (attempts >= MAX_ATTEMPTS) {
			await Segment.updateOne(scoped(accountId, { _id: claimed._id }), {
				$set: { buildStatus: "failed", buildAttempts: attempts, buildError: String(error?.message ?? error).slice(0, 300) },
				$unset: { lockedUntil: 1 },
			});
			return { failed: String(error?.message ?? error) };
		}
		await Segment.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { buildAttempts: attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}

// A build whose job went quiet gets another one.
export async function nudgeStaleSnapshots(account, segments) {
	const now = Date.now();
	for (const segment of segments) {
		const isQuiet = segment.buildStatus === "building" && segment.updatedAt < new Date(now - STALE_MS) && !(segment.lockedUntil > new Date(now));
		if (isQuiet) await publishStep(scoped(account).accountId, segment._id);
	}
}

export async function deleteSnapshotMembers(account, segmentId) {
	await SegmentMember.deleteMany(scoped(account, { segmentId }));
}
