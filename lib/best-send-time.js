import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter } from "@/lib/actions/shared";
import { hourIn, shiftDateKey, toDateKey, zonedTimeToInstant } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";

export function rankSendTimes(campaigns, timeZone, now = new Date()) {
	try { new Intl.DateTimeFormat("en", { timeZone }).format(now); }
	catch { throw actionError("validation_failed", "Use an IANA time zone"); }
	const groups = new Map();
	for (const campaign of campaigns) {
		const at = new Date(campaign.startedAt ?? campaign.sentAt);
		const sent = campaign.stats?.sent ?? 0;
		if (!Number.isFinite(+at) || sent < 20 || +now - +at < 48 * 3600000) continue;
		const weekday = new Date(`${toDateKey(at, timeZone)}T12:00:00Z`).getUTCDay();
		const hour = hourIn(at, timeZone);
		const key = `${weekday}:${hour}`;
		const group = groups.get(key) ?? { weekday, hour, campaigns: 0, sent: 0, opened: 0 };
		group.campaigns++; group.sent += sent; group.opened += Math.min(sent, campaign.stats?.opened ?? 0);
		groups.set(key, group);
	}
	const samples = [...groups.values()].map((group) => ({ ...group, openRate: group.opened / group.sent }));
	const ranked = samples.filter((group) => group.campaigns >= 3 && group.sent >= 100).sort((a, b) => b.openRate - a.openRate || b.campaigns - a.campaigns || a.weekday - b.weekday || a.hour - b.hour);
	const best = ranked[0];
	let suggestedAt = null;
	if (best) for (let offset = 0; offset <= 8; offset++) {
		const date = shiftDateKey(toDateKey(now, timeZone), offset);
		if (new Date(`${date}T12:00:00Z`).getUTCDay() !== best.weekday) continue;
		const instant = zonedTimeToInstant(date, `${String(best.hour).padStart(2, "0")}:00`, timeZone);
		if (+instant > +now + 3600000) { suggestedAt = instant.toISOString(); break; }
	}
	return { timeZone, suggestedAt, basis: best ? "observed_opens" : "insufficient_data", note: "Observed opens can include privacy proxies. This is a historical association, not a predicted lift. Needs three completed campaigns and 100 sends in the same weekday/hour; excludes the last 48 hours.", samples };
}
export async function getBestSendTime(account, input, now = new Date()) {
	const newsletter = await findNewsletter(account, input.newsletter);
	const campaigns = await Campaign.find(scoped(account, { newsletterId: newsletter._id, status: "sent", source: { $ne: "import" }, startedAt: { $gte: new Date(+now - 90 * 86400000) }, "stats.sent": { $gte: 20 } })).select({ startedAt: 1, sentAt: 1, stats: 1 }).sort({ startedAt: -1 }).limit(500).lean();
	return { newsletterId: String(newsletter._id), ...rankSendTimes(campaigns, input.timeZone ?? "UTC", now) };
}
