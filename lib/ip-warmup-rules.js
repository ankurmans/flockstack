import { judgeWatch } from "./account-watch-rules.js";
import { WATCH } from "./config.js";

// Warming up a standard dedicated IP, which FlockStack does itself. SES has no pool per message, so an account with an IP
// has two configuration sets, one on shared IPs and one pointed at its own pool, and each email picks one: a share of
// them, growing a day at a time, goes through the pool until all do. Relative imports only: the tests run these rules in
// plain Node.
//
// Where the numbers come from. AWS publishes no day-by-day volume table for standard IPs. Its guide says warm-up takes
// from about two weeks to six, varying by mailbox provider, to start with the most engaged recipients, and to send less
// when bounces or blocking and throttling notices rise (docs.aws.amazon.com/ses/latest/dg/dedicated-ip-warming.html).
// SES's own automatic warm-up is a plan over 45 days that doesn't look at volume, and it sends the rest through shared IPs,
// as this does; after warm-up it asks for around 1,000 emails a day to each provider you want a reputation with. So the
// share grows geometrically over 30 days, from 2% to 100% (about 50 times, doubling every five days), and a day with trouble or with no mail to warm it with is held.
export const IP_WARMUP = {
	days: 30,
	firstShare: 2,
	// A day counts only if the account sent at least this many emails in the last 24 hours: an idle IP isn't warming.
	minDailyEmails: 25,
	// The job waits this long after a day was counted before it counts the next, so its hourly run is safe to repeat.
	dayHours: 23,
};

const HOURS = 60 * 60 * 1000;

// The percent of the account's email that goes through its IP on a day of the warm-up, 1 to days, to one decimal.
export function getShareForDay(day) {
	if (!Number.isFinite(day) || day <= 0) return 0;
	if (day >= IP_WARMUP.days) return 100;
	const growth = (100 / IP_WARMUP.firstShare) ** ((day - 1) / (IP_WARMUP.days - 1));
	return Math.round(IP_WARMUP.firstShare * growth * 10) / 10;
}

export function getWarmupSchedule() {
	return Array.from({ length: IP_WARMUP.days }, (_, index) => ({ day: index + 1, share: getShareForDay(index + 1) }));
}

// FNV-1a over the message id, then a mixing step, so ids that differ in their last digits (ObjectIds made a moment apart)
// still land all over 0 to 99.99.
function hashId(id) {
	let hash = 0x811c9dc5;
	for (const char of String(id)) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

// Whether this message goes through the account's own IP. The same id always answers the same, so a retry takes the
// route the first try took, and as the share grows a message only ever moves towards the IP.
export function isRoutedToDedicatedIp(messageId, share) {
	if (!(share > 0)) return false;
	if (share >= 100) return true;
	return hashId(messageId) % 10_000 < share * 100;
}

// The configuration set an email is sent with: the account's dedicated one while it has an IP in a pool and the message
// falls in the share, else the account's own shared one. tenant is account.ses.
export function pickConfigurationSet(tenant, messageId) {
	const dedicated = tenant?.dedicatedConfigurationSet;
	if (!dedicated || !tenant.ipWarmup) return { configurationSet: tenant.configurationSet, isDedicated: false };
	const share = tenant.ipWarmup.completedAt ? 100 : (tenant.ipWarmup.share ?? 0);
	if (!isRoutedToDedicatedIp(messageId, share)) return { configurationSet: tenant.configurationSet, isDedicated: false };
	return { configurationSet: dedicated, isDedicated: true };
}

// The second configuration set's name: the account's, with -ip. SES allows 64 characters.
export function getDedicatedConfigurationSetName(configurationSet) {
	return `${configurationSet}-ip`;
}

// What the hourly job does with an account's warm-up: "wait" (the day isn't over), "advance" to the next day, or "hold"
// the day, with why. counts: the account's last 7 days of sends (lib/account-health.js). emailsLastDay: the emails it sent
// in the last 24 hours. isPaused: the account is blocked or paused. Rates are judged at the early-warning level
// (WATCH): the level at which the owner is already told, well under the one that blocks.
export function judgeWarmupStep({ warmup, counts, emailsLastDay, isPaused = false, now = new Date(), watch = WATCH }) {
	if (!warmup?.startedAt || warmup.completedAt) return { action: "wait", reason: "not warming" };
	const lastCounted = new Date(warmup.advancedAt ?? warmup.startedAt).getTime();
	if (now.getTime() - lastCounted < IP_WARMUP.dayHours * HOURS) return { action: "wait", reason: "the day isn't over" };
	if (isPaused) return { action: "hold", reason: "the account is paused" };
	const issues = judgeWatch(counts, watch).map(({ issue }) => issue);
	if (issues.length > 0) return { action: "hold", reason: `${issues.join(" and ")} are above the watch level` };
	if (emailsLastDay < IP_WARMUP.minDailyEmails) return { action: "hold", reason: "the account sent too little to warm the IP" };
	return { action: "advance", reason: "" };
}

// For the billing page and get_billing.
export function describeWarmup(warmup) {
	if (!warmup?.startedAt) return null;
	const isDone = Boolean(warmup.completedAt);
	return {
		day: isDone ? IP_WARMUP.days : (warmup.day ?? 1),
		days: IP_WARMUP.days,
		share: isDone ? 100 : (warmup.share ?? 0),
		isDone,
		isHeld: !isDone && Boolean(warmup.holdReason),
	};
}
