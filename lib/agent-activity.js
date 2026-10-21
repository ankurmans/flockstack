import "server-only";
import { scoped } from "@/lib/account-scope";
import { ACTIVITY_RETENTION_DAYS, getDay } from "@/lib/agent-activity-rules";
import { connectDb } from "@/lib/db";
import AgentActivity from "@/models/AgentActivity";
import AgentDay from "@/models/AgentDay";

const PURGE_PER_RUN = 5000;

// A line in the log. Never throws: a failing log must not fail the call it describes.
export async function recordActivity(account, entry) {
	try {
		await AgentActivity.create({ accountId: account._id, ...entry });
	} catch (error) {
		console.error("[agent-activity] Could not record:", error?.message);
	}
}

// The call counts for its day. With a cap, it only counts while the day is under it: returns false when the cap is reached,
// and the call doesn't happen. The unique key on (actor, day) is what stops two calls from both taking the last one.
export async function countCall(account, agent, { isChange = false, denied = false, scaled = 0, cap = null } = {}) {
	const day = getDay();
	const inc = { calls: 1, ...(isChange && { changes: 1 }), ...(denied && { denied: 1 }), ...(scaled > 0 && { scaled }) };
	const filter = { actorId: agent.id, day, ...(cap && { calls: { $lt: cap } }) };
	try {
		await AgentDay.updateOne(scoped(account, filter), { $inc: inc, $set: { actorType: agent.type, actorName: agent.name } }, { upsert: true });
		return true;
	} catch (error) {
		if (error?.code === 11000) return false;
		console.error("[agent-activity] Could not count:", error?.message);
		return true;
	}
}

// What an actor has done today, for the scale limits and the API keys page.
export async function getDayCounts(account, actorIds, day = getDay()) {
	if (actorIds.length === 0) return new Map();
	const rows = await AgentDay.find(scoped(account, { actorId: { $in: actorIds }, day })).lean();
	return new Map(rows.map((row) => [row.actorId, row]));
}

// Per day for the last `days` days, newest first: the aggregate view that doesn't need the log's rows.
export async function listDayCounts(account, { actorId = null, days = 14 } = {}) {
	const since = getDay(new Date(Date.now() - (days - 1) * 86_400_000));
	const rows = await AgentDay.find(scoped(account, { day: { $gte: since }, ...(actorId && { actorId }) })).lean();
	const byDay = new Map();
	for (const row of rows) {
		const total = byDay.get(row.day) ?? { day: row.day, calls: 0, changes: 0, denied: 0 };
		total.calls += row.calls ?? 0;
		total.changes += row.changes ?? 0;
		total.denied += row.denied ?? 0;
		byDay.set(row.day, total);
	}
	return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export const ACTIVITY_PAGE_SIZE = 50;

function toDateFilter(days) {
	return { $gte: new Date(Date.now() - days * 86_400_000) };
}

// Newest first. Filters: actorId, action, newsletterId, status, days. after: a filter for the rows after a cursor (afterCursor).
export async function listActivity(account, { actorId, action, newsletterId, status, days = ACTIVITY_RETENTION_DAYS, limit = ACTIVITY_PAGE_SIZE, after } = {}) {
	const filter = {
		createdAt: toDateFilter(days),
		...after,
		...(actorId && { actorId }),
		...(action && { action }),
		...(newsletterId && { newsletterId }),
		...(status && { status }),
	};
	const rows = await AgentActivity.find(scoped(account, filter)).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
	return { entries: rows.slice(0, limit), hasMore: rows.length > limit };
}

// Deletes what is older than the retention, a bounded number of rows per run: D1 has a size cap and the hourly cron a time limit.
export async function purgeAgentActivity(now = new Date()) {
	await connectDb();
	const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86_400_000);
	const [activity, days] = await Promise.all([
		AgentActivity.deleteMany({ createdAt: { $lt: cutoff } }).setOptions({ crossAccount: true, limit: PURGE_PER_RUN }),
		AgentDay.deleteMany({ day: { $lt: getDay(cutoff) } }).setOptions({ crossAccount: true, limit: PURGE_PER_RUN }),
	]);
	return { activity: activity.deletedCount ?? 0, days: days.deletedCount ?? 0 };
}
