import "server-only";
import { scoped } from "@/lib/account-scope";
import { getDayKey } from "@/lib/forms";
import {
	BREAKDOWNS,
	DEFAULT_REPORT_DAYS,
	JOINED_STATUSES,
	LEFT_STATUSES,
	buildBuckets,
	getBucketKey,
	getDefaultGranularity,
	getGroupIdentity,
	foldGroups,
	listDayKeys,
	toRate,
} from "@/lib/report-rules";
import { shiftDateKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";
import CampaignLink from "@/models/CampaignLink";
import Contact from "@/models/Contact";
import Form from "@/models/Form";

const DAY = { path: "subscribedAt", slice: 10 };
// What each breakdown groups the contacts by, besides their day.
const BREAKDOWN_GROUPS = {
	none: {},
	source: { source: "source" },
	form: { source: "source" },
	channel: { channel: "acquisition.channel", source: "source" },
	campaign: { campaign: "acquisition.utm.campaign" },
};

function startOf(dayKey) {
	return new Date(`${dayKey}T00:00:00.000Z`);
}

async function getFormNames(account, newsletterId) {
	const forms = await Form.find(scoped(account, { newsletterId })).select({ name: 1 }).lean();
	return new Map(forms.map(({ _id, name }) => [String(_id), name]));
}

// How a newsletter grew over `days`: for each bucket (days, weeks or months) the subscribers who joined, who left, the net
// and the total, and the same joins split by where they came from. A contact joins on the day it signed up unless it is
// still waiting for its confirmation; it leaves on the day it unsubscribed, bounced or complained (imports, whose dates
// aren't theirs, leave out). The total is worked back from today's active subscribers. Every number is one GROUP BY on the contacts.
export async function getGrowthReport({ account, newsletter, days = DEFAULT_REPORT_DAYS, granularity, by = "source", now = new Date() }) {
	if (!BREAKDOWNS.includes(by)) throw new Error(`Can't break down by ${by}`);
	const bucketing = granularity ?? getDefaultGranularity(days);
	const today = getDayKey(now);
	const dayKeys = listDayKeys(today, days);
	const buckets = buildBuckets(dayKeys, bucketing);
	const indexOf = new Map(buckets.map(({ key }, index) => [key, index]));
	const from = startOf(dayKeys[0]);
	const until = startOf(shiftDateKey(today, 1));
	const base = scoped(account, { newsletterId: newsletter._id });
	const joined = { ...base, subscribedAt: { $gte: from, $lt: until }, status: { $in: JOINED_STATUSES } };
	const groups = BREAKDOWN_GROUPS[by];

	const [newRows, stillActive, leftRows, activeNow, pending, formNames] = await Promise.all([
		Contact.groupCount(joined, { day: DAY, ...groups }),
		Contact.groupCount({ ...joined, status: "active" }, groups),
		Contact.groupCount(
			{ ...base, status: { $in: LEFT_STATUSES }, unsubscribedAt: { $gte: from, $lt: until }, source: { $ne: "import" } },
			{ day: { path: "unsubscribedAt", slice: 10 } }
		),
		Contact.countDocuments({ ...base, status: "active" }),
		Contact.countDocuments({ ...base, status: "pending" }),
		by === "source" || by === "form" ? getFormNames(account, newsletter._id) : new Map(),
	]);

	const series = buckets.map(({ key, label }) => ({ key, label, new: 0, left: 0, net: 0, total: 0 }));
	const found = new Map();
	const group = (row) => {
		const identity = getGroupIdentity(by, row, formNames);
		if (!identity) return null;
		if (!found.has(identity.key)) found.set(identity.key, { ...identity, new: 0, active: 0, series: buckets.map(() => 0) });
		return found.get(identity.key);
	};
	for (const row of newRows) {
		const index = indexOf.get(getBucketKey(row.day, bucketing));
		if (index === undefined) continue;
		series[index].new += row.count;
		if (by !== "none") {
			const target = group(row);
			if (target) {
				target.new += row.count;
				target.series[index] += row.count;
			}
		}
	}
	for (const row of stillActive) {
		const target = by === "none" ? null : group(row);
		if (target) target.active += row.count;
	}
	for (const row of leftRows) {
		const index = indexOf.get(getBucketKey(row.day, bucketing));
		if (index !== undefined) series[index].left += row.count;
	}
	let running = activeNow;
	for (let index = series.length - 1; index >= 0; index -= 1) {
		series[index].net = series[index].new - series[index].left;
		series[index].total = running;
		running -= series[index].net;
	}

	const totals = series.reduce((sum, bucket) => ({ new: sum.new + bucket.new, left: sum.left + bucket.left }), { new: 0, left: 0 });
	return {
		from: dayKeys[0],
		to: today,
		days,
		granularity: bucketing,
		by,
		buckets: series,
		groups: by === "none" ? [] : foldGroups([...found.values()]).map((item) => ({ ...item, retention: toRate(item.active, item.new) })),
		totals: { ...totals, net: totals.new - totals.left, active: activeNow, pending, startingActive: running },
	};
}

const SENT_STATUSES = ["sending", "paused", "sent"];
export const MAX_COMPARED = 25;

// Sent issues side by side, newest first: what went out, what it got and what it cost in unsubscribes. ids: these issues
// (10 at most), else the newest `limit` in the range. Each issue's rates come from its own counters, read in one
// query, and its most-clicked link from its link counters, read in another: nothing here reads a row per event.
export async function compareIssues({ account, newsletter, ids = null, limit = 10, from = null, to = null }) {
	const filter = scoped(account, {
		newsletterId: newsletter._id,
		status: { $in: SENT_STATUSES },
		importKey: { $exists: false },
		...(ids && { _id: { $in: ids } }),
		...((from || to) && { sentAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } }),
	});
	const issues = await Campaign.find(filter)
		.sort({ sentAt: -1, _id: -1 })
		.limit(ids ? ids.length : Math.min(limit, MAX_COMPARED))
		.select("subject sentAt startedAt audience stats webViews archiveSlug")
		.lean();
	const links = issues.length > 0 ? await CampaignLink.find(scoped(account, { campaignId: { $in: issues.map(({ _id }) => _id) } })).select({ campaignId: 1, url: 1, uniqueClicks: 1 }).lean() : [];
	const top = new Map();
	for (const link of links) {
		const key = String(link.campaignId);
		if (!top.has(key) || link.uniqueClicks > top.get(key).uniqueClicks) top.set(key, link);
	}

	return issues.map((issue) => {
		const stats = issue.stats ?? {};
		const reached = stats.delivered || stats.sent || 0;
		const favorite = top.get(String(issue._id));
		return {
			id: String(issue._id),
			subject: issue.subject,
			sentAt: issue.sentAt ?? issue.startedAt ?? null,
			audience: issue.audience ?? "all",
			sent: stats.sent ?? 0,
			delivered: stats.delivered ?? 0,
			opened: stats.opened ?? 0,
			openRate: toRate(stats.opened ?? 0, reached),
			clicked: stats.clicked ?? 0,
			clickRate: toRate(stats.clicked ?? 0, reached),
			unsubscribed: stats.unsubscribed ?? 0,
			unsubscribeRate: toRate(stats.unsubscribed ?? 0, reached),
			bounced: stats.bounced ?? 0,
			complained: stats.complained ?? 0,
			webViews: issue.webViews ?? 0,
			topLink: favorite && favorite.uniqueClicks > 0 ? { url: favorite.url, uniqueClicks: favorite.uniqueClicks } : null,
		};
	});
}
