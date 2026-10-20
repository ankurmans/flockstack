import "server-only";
import { describeWatch } from "@/lib/account-watch-rules";
import { sendAlert } from "@/lib/alerts";
import { WATCH } from "@/lib/config";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";

const PERIOD_MINUTES = WATCH.periodDays * 24 * 60;

// An account past the watch level on one issue (lib/account-watch-rules.js): stored for the dashboard's banner, emailed
// to its owner and recorded for the admins, each once per issue per period however often it is seen (sendAlert's
// cooldown). A blocked account gets nothing: its block says more. limits: the block levels the text names, a Free account's
// when it is one (lib/rate-levels.js). True when it was noted.
export async function noteWatch(accountId, { issue, rate, limit, count, sent, detail }, { now = new Date(), limits } = {}) {
	await connectDb();
	const seen = Object.fromEntries(Object.entries({ rate, limit, count, sent, detail, seenAt: now }).filter(([, value]) => value !== undefined));
	const { matchedCount } = await Account.updateOne({ _id: accountId, status: { $ne: "paused" } }, { $set: { [`watch.${issue}`]: seen } });
	if (matchedCount === 0) return false;
	const text = describeWatch({ issue, rate, limit, count, sent, detail }, limits);
	await Promise.all([
		sendAlert({ accountId, key: `watch-${issue}`, title: text.title, detail: text.detail, action: text.action, path: "/", cooldownMinutes: PERIOD_MINUTES }),
		sendAlert({
			accountId: null,
			key: `account-watch:${accountId}:${issue}`,
			title: "Account close to a block",
			detail: `Account ${accountId}: ${text.detail}`,
			action: "Nothing is stopped yet, and its owner was emailed what to do. Look at it on the admin page if it doesn't come down.",
			path: "/admin",
			cooldownMinutes: PERIOD_MINUTES,
		}),
	]);
	return true;
}

// Back under the level: the banner goes. The next time it passes, the owner hears again once the period is over.
export async function clearWatch(accountId, issues) {
	if (issues.length === 0) return;
	await connectDb();
	await Account.updateOne({ _id: accountId }, { $unset: Object.fromEntries(issues.map((issue) => [`watch.${issue}`, 1])) });
}
