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

// What the text AI cost an account today, by provider, model and feature: counts, never text (lib/platform-ai.js). One field per
// combination, its name made of letters, digits and underscores. costMicros is millionths of a US dollar at list price, an
// estimate to attribute spend by account, not an invoice. Never throws: a tally that can't be written doesn't fail the request.
export function spendKey({ provider, model, feature }) {
	return [provider, model, feature].map((part) => String(part).toLowerCase().replace(/[^a-z0-9]+/g, "_")).join("__");
}

export async function recordAiCall(account, { feature, provider, model, failed = false, inputTokens = 0, outputTokens = 0, costMicros = 0 }, now = new Date()) {
	if (!account?._id) return;
	const base = `spend.${spendKey({ provider, model, feature })}`;
	const inc = failed
		? { [`${base}.failed`]: 1 }
		: { [`${base}.calls`]: 1, [`${base}.inputTokens`]: inputTokens, [`${base}.outputTokens`]: outputTokens, [`${base}.costMicros`]: costMicros };
	try {
		await AiUsage.updateOne(scoped(account, { day: getUsageDay(now) }), { $inc: inc }, { upsert: true });
	} catch (error) {
		console.error("[ai] usage tally failed:", error?.message);
	}
}

// The account's tally for one UTC day: [{ provider, model, feature, calls, failed, inputTokens, outputTokens, costMicros }].
export async function getAiSpend(account, now = new Date()) {
	const row = await AiUsage.findOne(scoped(account, { day: getUsageDay(now) })).lean();
	return Object.entries(row?.spend ?? {}).map(([key, tally]) => {
		const [provider, model, feature] = key.split("__");
		return { provider, model, feature, calls: tally.calls ?? 0, failed: tally.failed ?? 0, inputTokens: tally.inputTokens ?? 0, outputTokens: tally.outputTokens ?? 0, costMicros: tally.costMicros ?? 0 };
	});
}
