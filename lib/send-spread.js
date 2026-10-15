import { FIRST_SEND, WARMUP, isCloud } from "./config.js";
import { getFirstSendSlice } from "./first-send.js";
import { judgeRates } from "./rate-levels.js";

// A send goes out in batches of this many, one QStash job each.
export const SEND_BATCH_SIZE = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The end of the account's warm-up, 30 days after its first campaign.
export function getSpreadEnd(from = new Date()) {
	return new Date(from.getTime() + WARMUP.days * DAY_MS);
}

// The account's day in its warm-up, 1 to 30: 0 before its first campaign starts it, null once it's over or an admin
// ended it (spreadUntil in the past).
export function getWarmupDay(account, now = new Date()) {
	if (!account?.spreadUntil) return 0;
	const endsAt = new Date(account.spreadUntil).getTime();
	if (endsAt <= now.getTime()) return null;
	const elapsed = Math.max(0, now.getTime() - (endsAt - WARMUP.days * DAY_MS));
	return Math.min(WARMUP.days, Math.floor(elapsed / DAY_MS) + 1);
}

// How many times its proven volume a send can be at full speed: 2 on the warm-up's first day, a little more each day,
// 5 on its last day and from then on.
export function getGrowth(day) {
	const { first, last } = WARMUP.growth;
	if (day === null) return last;
	return first + ((last - first) * Math.max(0, day - 1)) / (WARMUP.days - 1);
}

export function getAllowance({ proven = 0, day = null } = {}) {
	return Math.max(WARMUP.quickEmails, Math.floor(proven * getGrowth(day)));
}

// The hours a send goes out over, 0 at full speed. emails: its own. recent: what the account's other sends still have to
// send or sent in the last day, so a send split into small ones, or sent beside others, goes out at the same pace.
export function getSendHours({ emails, recent = 0, proven = 0, day = null }) {
	const total = emails + recent;
	const allowance = getAllowance({ proven, day });
	if (emails <= SEND_BATCH_SIZE || total <= allowance) return 0;
	return Math.min(WARMUP.maxHours, Math.ceil(WARMUP.minHours + WARMUP.hoursPerDoubling * Math.log2(total / allowance)));
}

// The account's proven volume: the most emails one of its campaigns sent, steps and last-chance emails included, with
// bounces and complaints under the pause level, in the last 60 days and at least a day ago.
export function getProvenEmails(campaigns, now = new Date()) {
	const from = now.getTime() - WARMUP.provenDays * DAY_MS;
	const settled = now.getTime() - WARMUP.recentHours * HOUR_MS;
	let proven = 0;
	for (const { stats, lastChance, finishedAt, sentAt } of campaigns) {
		const at = new Date(finishedAt ?? sentAt).getTime();
		const total = (key) => (stats?.[key] ?? 0) + (lastChance?.[key] ?? 0);
		const counts = { sent: total("sent"), bounced: total("bounced"), complained: total("complained") };
		if (at >= from && at <= settled && !judgeRates(counts)) proven = Math.max(proven, counts.sent);
	}
	return proven;
}

// Where the account is in its warm-up, for the dashboard; null once it's over, and on a self-hosted server.
export function getWarmup(account, { now = new Date(), env = process.env } = {}) {
	if (!isCloud(env)) return null;
	const day = getWarmupDay(account, now);
	if (day === null) return null;
	if (day === 0) return { days: WARMUP.days, day, hasStarted: false, progress: 0, endsAt: null };
	const endsAt = new Date(account.spreadUntil);
	const elapsed = now.getTime() - (endsAt.getTime() - WARMUP.days * DAY_MS);
	return { days: WARMUP.days, day, hasStarted: true, progress: Math.min(1, Math.max(0, elapsed / (WARMUP.days * DAY_MS))), endsAt: endsAt.toISOString() };
}

// What the dashboard needs to tell how a send goes out (getPaceHours); null on a self-hosted server, which sends at
// full speed. proven, recent: from getSendVolumes (lib/campaign-queries.js).
export function getPace(account, { proven = 0, recent = 0, now = new Date(), env = process.env } = {}) {
	if (!isCloud(env)) return null;
	return { proven, recent, warmup: getWarmup(account, { now, env }) };
}

function getPaceDay(pace) {
	return pace.warmup ? pace.warmup.day : null;
}

// How many emails go out at full speed right now, on top of the account's recent ones. One batch always does.
export function getPaceRoom(pace) {
	return Math.max(SEND_BATCH_SIZE, getAllowance({ proven: pace.proven, day: getPaceDay(pace) }) - pace.recent);
}

// From now to a send's last batch, in hours, as the dashboard says it: 0 at full speed, else its hours and the wait
// before a first send's held contacts. newContacts: the send's contacts never mailed.
export function getPaceHours(pace, { emails, newContacts = 0 }) {
	if (!pace) return 0;
	const hours = getSendHours({ emails, recent: pace.recent, proven: pace.proven, day: getPaceDay(pace) });
	if (!hours) return 0;
	return hours + (getFirstSendSlice(Math.min(newContacts, emails)) ? FIRST_SEND.waitMinutes / 60 : 0);
}

// When each batch may start, in Unix seconds: the first right away, the last at the end of the spread, the others
// evenly between.
export function getBatchStarts(count, spreadMs, now = Date.now()) {
	return Array.from({ length: count }, (_, index) =>
		spreadMs && index > 0 ? Math.floor((now + (index * spreadMs) / (count - 1)) / 1000) : null
	);
}
