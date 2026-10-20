import "server-only";
import { codedError } from "@/lib/account-state";
import { scoped } from "@/lib/account-scope";
import { formatNumber } from "@/lib/format";
import { getAudioLimit } from "@/lib/plans";
import AudioUsage from "@/models/AudioUsage";

// ElevenLabs bills the owner by the character, so audio is counted by the character, per account and calendar month (UTC),
// and refused up front when a job would go past the plan's quota: there is no overage. A job reserves its characters when it
// is created; the ones it reads are used for good when it ends, and the rest go back. A failed job costs the quota only what
// the voice really read.
const ATTEMPTS = 6;

export function getMonthKey(now = new Date()) {
	return now.toISOString().slice(0, 7);
}

function getNextMonthStart(now = new Date()) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

async function ensureUsage(account, month) {
	await AudioUsage.updateOne(scoped(account, { month }), { $setOnInsert: { month, used: 0, reserved: 0 } }, { upsert: true });
	return AudioUsage.findOne(scoped(account, { month })).lean();
}

// The month so far: characters read, characters held for jobs still running, the limit (null: none) and what is left.
export async function getAudioQuota(account, now = new Date()) {
	const month = getMonthKey(now);
	const usage = await AudioUsage.findOne(scoped(account, { month })).lean();
	const used = usage?.used ?? 0;
	const reserved = usage?.reserved ?? 0;
	const limit = getAudioLimit(account);
	return { month, used, reserved, limit, left: limit === null ? null : Math.max(0, limit - used - reserved), resetsAt: getNextMonthStart(now) };
}

export function describeQuotaShortfall({ wanted, left, limit }) {
	return `This needs about ${formatNumber(wanted)} characters of audio, and this month has ${formatNumber(left)} left of ${formatNumber(limit)}. The count starts over on the 1st.`;
}

// Holds `characters` for a job, or throws audio_quota_exceeded. Compare-and-set on the counters, so two jobs created at once
// can't both take the last of it.
export async function reserveCharacters(account, characters, now = new Date()) {
	const month = getMonthKey(now);
	const limit = getAudioLimit(account);
	for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
		const usage = await ensureUsage(account, month);
		if (limit !== null && usage.used + usage.reserved + characters > limit) {
			const left = Math.max(0, limit - usage.used - usage.reserved);
			throw codedError({ code: "audio_quota_exceeded", message: describeQuotaShortfall({ wanted: characters, left, limit }) });
		}
		const { modifiedCount } = await AudioUsage.updateOne(scoped(account, { _id: usage._id, used: usage.used, reserved: usage.reserved }), { $inc: { reserved: characters } });
		if (modifiedCount === 1) return month;
	}
	throw codedError({ code: "conflict", message: "Audio versions are being made at the same moment: try again in a few seconds" });
}

// A job has ended: `used` of its reserved characters were read, the rest go back.
export async function settleCharacters(account, month, { reserved, used }) {
	await AudioUsage.updateOne(scoped(account, { month }), { $inc: { used, reserved: -reserved } });
}
