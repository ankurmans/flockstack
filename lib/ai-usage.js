import { scoped } from "@/lib/account-scope";
import { getAiDailyLimit } from "@/lib/plans";
import AiUsage from "@/models/AiUsage";

const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getUsageDay(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

// When the count starts over: the next UTC midnight.
export function getUsageResetAt(now = new Date()) {
	return new Date(Date.parse(getUsageDay(now)) + DAY_MS);
}

export async function getAiUsage(account, now = new Date()) {
	const row = await AiUsage.findOne(scoped(account, { day: getUsageDay(now) })).lean();
	const limit = getAiDailyLimit(account);
	const used = row?.count ?? 0;
	return { used, limit, left: limit === null ? null : Math.max(0, limit - used), resetsAt: getUsageResetAt(now).toISOString() };
}

// Takes one request from today's allowance before the model is asked. The count goes up first and comes back down when
// it went past the limit, so two requests at once can't both take the last one.
export async function takeAiRequest(account, now = new Date()) {
	const limit = getAiDailyLimit(account);
	const day = getUsageDay(now);
	const row = await AiUsage.findOneAndUpdate(scoped(account, { day }), { $inc: { count: 1 } }, { upsert: true, returnDocument: "after" }).lean();
	if (limit !== null && row.count > limit) {
		await AiUsage.updateOne(scoped(account, { day }), { $inc: { count: -1 } });
		return { allowed: false, used: Math.min(row.count - 1, limit), limit, resetsAt: getUsageResetAt(now).toISOString() };
	}
	if (row.count === 1) {
		const cutoff = getUsageDay(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
		await AiUsage.deleteMany(scoped(account, { day: { $lt: cutoff } }));
	}
	return { allowed: true, used: row.count, limit, resetsAt: getUsageResetAt(now).toISOString() };
}

// A request the model couldn't answer isn't counted.
export async function returnAiRequest(account, now = new Date()) {
	await AiUsage.updateOne(scoped(account, { day: getUsageDay(now), count: { $gt: 0 } }), { $inc: { count: -1 } });
}
