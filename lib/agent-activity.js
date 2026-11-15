import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { ACTIVITY_EXPORT_LIMIT, ACTIVITY_PURGE_PER_RUN, ACTIVITY_RETENTION_CHOICES, ACTIVITY_RETENTION_DAYS, getDay, getRetentionDays } from "@/lib/agent-activity-rules";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";
import AgentActivity from "@/models/AgentActivity";
import AgentDay from "@/models/AgentDay";

// A line in the log. Never throws: a failing log must not fail the call it describes.
export async function recordActivity(account, entry) {
	try {
		await AgentActivity.create({ accountId: account._id, keepDays: getRetentionDays(account), ...entry });
	} catch (error) {
		console.error("[agent-activity] Could not record:", error?.message);
	}
}

// A person as the log names them: their name and role, never their email.
export function describePerson(account, user) {
	const role = String(account.ownerId) === String(user.id) ? "owner" : (account.memberRole ?? "member");
	const name = String(user.name ?? "").trim() || (role === "owner" ? "Account owner" : "Team member");
	return { actorType: "person", actorId: String(user.id), actorName: `${name} (${role})`.slice(0, 100) };
}

// The call counts for its day. With a cap, it only counts while the day is under it: returns false when the cap is reached,
// and the call doesn't happen. The unique key on (actor, day) is what stops two calls from both taking the last one.
export async function countCall(account, agent, { isChange = false, denied = false, scaled = 0, cap = null } = {}) {
	const day = getDay();
	const inc = { calls: 1, ...(isChange && { changes: 1 }), ...(denied && { denied: 1 }), ...(scaled > 0 && { scaled }) };
	const filter = { actorId: agent.id, day, ...(cap && { calls: { $lt: cap } }) };
	try {
		await AgentDay.updateOne(scoped(account, filter), { $inc: inc, $set: { actorType: agent.type, actorName: agent.name, keepDays: getRetentionDays(account) } }, { upsert: true });
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

function toFilter({ actorId, actorType, client, action, newsletterId, status, days }) {
	return {
		createdAt: toDateFilter(days),
		...(actorId && { actorId }),
		...(actorType && { actorType }),
		...(client && { actorName: client }),
		...(action && { action }),
		...(newsletterId && { newsletterId }),
		...(status && { status }),
	};
}

// Newest first. Filters: actorId, actorType, client (the key's, app's or person's name as the log shows it), action,
// newsletterId, status, days. after: a filter for the rows after a cursor (afterCursor).
export async function listActivity(account, { days = ACTIVITY_RETENTION_DAYS, limit = ACTIVITY_PAGE_SIZE, after, ...filters } = {}) {
	const rows = await AgentActivity.find(scoped(account, { ...toFilter({ ...filters, days }), ...after }))
		.sort({ createdAt: -1, _id: -1 })
		.limit(limit + 1)
		.lean();
	return { entries: rows.slice(0, limit), hasMore: rows.length > limit };
}

// The rows of a CSV export, newest first, at most ACTIVITY_EXPORT_LIMIT: isTruncated says there were more.
export async function listActivityForExport(account, { days = ACTIVITY_RETENTION_DAYS, ...filters } = {}) {
	const rows = await AgentActivity.find(scoped(account, toFilter({ ...filters, days })))
		.sort({ createdAt: -1, _id: -1 })
		.limit(ACTIVITY_EXPORT_LIMIT + 1)
		.lean();
	return { rows: rows.slice(0, ACTIVITY_EXPORT_LIMIT), isTruncated: rows.length > ACTIVITY_EXPORT_LIMIT };
}

// The names the log has for keys, apps and people in the last `days`, for the client filter.
export async function listActivityClients(account, days = ACTIVITY_RETENTION_DAYS) {
	const rows = await AgentActivity.find(scoped(account, { createdAt: toDateFilter(days) })).select({ actorType: 1, actorName: 1 }).sort({ createdAt: -1 }).limit(2000).lean();
	const clients = new Map();
	for (const { actorType, actorName } of rows) if (!clients.has(actorName)) clients.set(actorName, actorType);
	return [...clients].map(([name, type]) => ({ name, type }));
}

// The owner's retention choice. Every entry the account has takes it, so the next purge deletes by it.
export async function setActivityRetention(account, days) {
	if (!ACTIVITY_RETENTION_CHOICES.includes(days)) throw actionError("validation_failed", `Choose ${ACTIVITY_RETENTION_CHOICES.join(", ")} days`);
	await Account.updateOne({ _id: account._id }, { $set: { agentActivityRetentionDays: days } });
	await Promise.all([AgentActivity.updateMany(scoped(account), { $set: { keepDays: days } }), AgentDay.updateMany(scoped(account), { $set: { keepDays: days } })]);
	return days;
}

// Deletes what is older than each entry's retention, a bounded number of rows per choice per run: D1 has a size cap and the hourly
// cron a time limit. Entries from before the choice existed have no keepDays and keep the default.
export async function purgeAgentActivity(now = new Date()) {
	await connectDb();
	let activity = 0;
	let days = 0;
	for (const keep of ACTIVITY_RETENTION_CHOICES) {
		const cutoff = new Date(now.getTime() - keep * 86_400_000);
		const kept = keep === ACTIVITY_RETENTION_DAYS ? { $or: [{ keepDays: keep }, { keepDays: { $exists: false } }] } : { keepDays: keep };
		const options = { crossAccount: true, limit: ACTIVITY_PURGE_PER_RUN };
		const [rows, counts] = await Promise.all([
			AgentActivity.deleteMany({ ...kept, createdAt: { $lt: cutoff } }).setOptions(options),
			AgentDay.deleteMany({ ...kept, day: { $lt: getDay(cutoff) } }).setOptions(options),
		]);
		activity += rows.deletedCount ?? 0;
		days += counts.deletedCount ?? 0;
	}
	return { activity, days };
}
