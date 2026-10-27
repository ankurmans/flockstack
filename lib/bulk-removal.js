import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { BULK_LIMITS } from "@/lib/docdb/model";
import { isObjectIdString } from "@/lib/validation";
import BulkRemoval from "@/models/BulkRemoval";
import Contact from "@/models/Contact";

// A deleted tag or custom field comes off every contact that has it. A small list does it in the request; past `inline`
// contacts it runs in jobs, a chunk of contacts at a time (one page of docdb's updateMany), each job working for a while
// and then publishing the next: a real-D1 bench of similar bulk writes used about 3 s of CPU per 50,000 contacts, and a
// Worker gets 30 s. Tests lower these.
export const REMOVAL_LIMITS = { inline: 20_000, chunk: BULK_LIMITS.scanPage };
const LOCK_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
// A running removal no step has touched for this long lost its job (a Worker cut off, a lost delivery): the dashboard's
// next look publishes another.
const STALE_MS = 5 * 60_000;
// Finished removals stay in the list for this long.
const SHOW_DONE_MS = 60 * 60_000;

// BULK_REMOVAL_STEP_MS shortens a step, to one chunk per job in tests.
function getStepMs() {
	return process.env.BULK_REMOVAL_STEP_MS ? Number(process.env.BULK_REMOVAL_STEP_MS) : 20_000;
}

export function getRemovalJobUrl() {
	return `${getAppUrl()}/api/jobs/remove-from-contacts`;
}

async function publishStep(accountId, removalId) {
	const { publishJob } = await import("@/lib/sending");
	return publishJob({ url: getRemovalJobUrl(), body: { accountId: String(accountId), removalId: String(removalId) } });
}

function contactFilter({ kind, name }) {
	return kind === "tag" ? { tags: name } : { [`fields.${name}`]: { $exists: true } };
}

function contactUpdate({ kind, name }) {
	return kind === "tag" ? { $pull: { tags: name } } : { $unset: { [`fields.${name}`]: 1 } };
}

// The removal of this tag or field still running on the newsletter, if any.
export function findRunningRemoval(account, { newsletterId, kind, name }) {
	return BulkRemoval.findOne(scoped(account, { newsletterId, kind, name, status: "running" })).lean();
}

// While a tag or a field comes off a list in the background, it can't come back: the job would take it off contacts
// that just got it.
export async function refuseWhileRemoving(account, { newsletterId, kind, names }) {
	if (names.length === 0) return;
	const running = await BulkRemoval.findOne(scoped(account, { newsletterId, kind, name: { $in: names }, status: "running" }))
		.select({ name: 1 })
		.lean();
	if (!running) return;
	const what = kind === "tag" ? `The tag ${running.name}` : `The field ${running.name}`;
	throw actionError("conflict", `${what} is still being removed from your contacts. Add it again once that's done.`);
}

// Takes a tag or a field off every contact of a newsletter that has it. { contacts, inBackground }: contacts is how many
// lost it, or, in the background, how many will. A removal of the same one already running is that one.
export async function removeFromContacts(account, { newsletterId, kind, name, label = name }) {
	const target = { kind, name };
	const running = await findRunningRemoval(account, { newsletterId, kind, name });
	if (running) return { contacts: running.total, inBackground: true, removal: running };
	const filter = scoped(account, { newsletterId, ...contactFilter(target) });
	const total = await Contact.countDocuments(filter);
	if (total < REMOVAL_LIMITS.inline) {
		const { modifiedCount } = await Contact.updateMany(filter, contactUpdate(target));
		return { contacts: modifiedCount, inBackground: false };
	}
	const removal = (await BulkRemoval.create({ accountId: account._id, newsletterId, kind, name, label, total })).toObject();
	try {
		await publishStep(account._id, removal._id);
	} catch (error) {
		await BulkRemoval.updateOne(scoped(account, { _id: removal._id }), { $set: { status: "failed", error: "The job queue didn't take it", finishedAt: new Date() } });
		throw error;
	}
	return { contacts: total, inBackground: true, removal };
}

// One job of a removal: claims it, takes the tag or field off a chunk of contacts after the cursor at a time, saving the
// cursor after each, until its time is up, then publishes the next job. Contacts that lost it already don't match any
// more, so a chunk done twice changes nothing and counts nothing. A step that throws is tried again by QStash from the
// saved cursor; the third time in a row, the removal fails.
export async function runRemovalStep({ accountId, removalId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(removalId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await BulkRemoval.findOneAndUpdate(
		scoped(accountId, { _id: removalId, status: "running", $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }),
		{ $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) {
		const current = await BulkRemoval.findOne(scoped(accountId, { _id: removalId })).lean();
		return current?.status === "running" ? { busy: true } : { skipped: current?.status ?? "not found" };
	}

	const until = Date.now() + getStepMs();
	let { cursor = null, removed = 0 } = claimed;
	let isSwept = false;
	try {
		for (;;) {
			const matching = scoped(accountId, { newsletterId: claimed.newsletterId, ...contactFilter(claimed) });
			const page = await Contact.find({ ...matching, ...(cursor && { _id: { $gt: cursor } }) })
				.sort({ _id: 1 })
				.limit(REMOVAL_LIMITS.chunk)
				.select({ _id: 1 })
				.lean();
			if (page.length === 0) {
				// Past the last contact: one more pass from the start for any that got it back before the cursor went by.
				if (!isSwept && cursor && (await Contact.exists(matching))) {
					cursor = null;
					isSwept = true;
					continue;
				}
				await BulkRemoval.updateOne(scoped(accountId, { _id: claimed._id }), {
					$set: { status: "done", removed, attempts: 0, finishedAt: new Date() },
					$unset: { lockedUntil: 1, cursor: 1 },
				});
				return { done: true, removed };
			}
			const ids = page.map(({ _id }) => _id);
			const { modifiedCount } = await Contact.updateMany({ ...matching, _id: { $in: ids } }, contactUpdate(claimed));
			removed += modifiedCount;
			cursor = String(ids.at(-1));
			await BulkRemoval.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { cursor, removed } });
			if (Date.now() >= until) break;
		}
		await BulkRemoval.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { attempts: 0 }, $unset: { lockedUntil: 1 } });
		await publishStep(accountId, claimed._id);
		return { continued: true, removed };
	} catch (error) {
		const attempts = (claimed.attempts ?? 0) + 1;
		if (attempts >= MAX_ATTEMPTS) {
			await BulkRemoval.updateOne(scoped(accountId, { _id: claimed._id }), {
				$set: { status: "failed", attempts, error: String(error?.message ?? error).slice(0, 300), finishedAt: new Date() },
				$unset: { lockedUntil: 1 },
			});
			return { failed: String(error?.message ?? error) };
		}
		await BulkRemoval.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}

export function toRemovalOutput(removal) {
	const percent = removal.status === "done" ? 100 : Math.min(99, Math.floor(((removal.removed ?? 0) / Math.max(1, removal.total ?? 0)) * 100));
	return {
		id: String(removal._id),
		kind: removal.kind,
		name: removal.name,
		label: removal.label ?? removal.name,
		status: removal.status,
		total: removal.total ?? 0,
		removed: removal.removed ?? 0,
		percent,
	};
}

// A newsletter's removals running or stopped, and the ones done in the last hour. A running one whose job went quiet
// gets another.
export async function listRemovals(account, newsletterId) {
	await connectDb();
	const now = Date.now();
	const removals = await BulkRemoval.find(
		scoped(account, { newsletterId, $or: [{ status: { $in: ["running", "failed"] } }, { finishedAt: { $gt: new Date(now - SHOW_DONE_MS) } }] })
	)
		.sort({ createdAt: 1 })
		.lean();
	for (const removal of removals) {
		const isQuiet = removal.status === "running" && removal.updatedAt < new Date(now - STALE_MS) && !(removal.lockedUntil > new Date(now));
		if (!isQuiet) continue;
		await BulkRemoval.updateOne(scoped(account, { _id: removal._id }), { $set: { attempts: removal.attempts ?? 0 } });
		await publishStep(account._id, removal._id);
	}
	return removals.map(toRemovalOutput);
}


// A removal that failed starts again where its cursor stopped.
export async function retryRemoval(account, id) {
	if (!isObjectIdString(String(id))) throw actionError("not_found", "Removal not found");
	await connectDb();
	const removal = await BulkRemoval.findOneAndUpdate(
		scoped(account, { _id: id, status: "failed" }),
		{ $set: { status: "running", attempts: 0 }, $unset: { error: 1, finishedAt: 1, lockedUntil: 1 } },
		{ returnDocument: "after" }
	).lean();
	if (!removal) {
		const exists = await BulkRemoval.exists(scoped(account, { _id: id }));
		throw exists ? actionError("conflict", "This removal isn't stopped: it's running or done") : actionError("not_found", "Removal not found");
	}
	await publishStep(account._id, removal._id);
	return toRemovalOutput(removal);
}
