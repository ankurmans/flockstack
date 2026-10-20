import { CHANNEL_LABELS, classifyChannel } from "./attribution.js";
import { toCell } from "./contacts-csv.js";
import { shiftDateKey } from "./time-zone.js";

// The reports page's shared rules: ranges, buckets by day, week or month, the names of what a signup came from, and CSV. Days
// are UTC everywhere, as the form stats' are: a report reads dates the database stores in UTC, in one GROUP BY.
export const MAX_REPORT_DAYS = 730;
export const DEFAULT_REPORT_DAYS = 90;
export const GRANULARITIES = ["day", "week", "month"];
export const BREAKDOWNS = ["none", "source", "channel", "campaign", "form"];
// Pending contacts haven't joined; the rest have, and may have left since.
export const JOINED_STATUSES = ["active", "unsubscribed", "bounced", "complained", "dormant"];
export const LEFT_STATUSES = ["unsubscribed", "bounced", "complained"];
export const MAX_GROUPS = 8;
export const OTHER_KEY = "(other)";
export const NONE_KEY = "(none)";

// Fewer buckets for a longer range: a year of days is a wall.
export function getDefaultGranularity(days) {
	if (days <= 60) return "day";
	return days <= 365 ? "week" : "month";
}

// The days of the range, oldest first, ending today.
export function listDayKeys(todayKey, days) {
	return Array.from({ length: days }, (_, index) => shiftDateKey(todayKey, index - days + 1));
}

// A day's bucket: itself, the Monday of its week, or its month.
export function getBucketKey(dayKey, granularity) {
	if (granularity === "month") return dayKey.slice(0, 7);
	if (granularity === "week") {
		const weekday = (new Date(`${dayKey}T12:00:00Z`).getUTCDay() + 6) % 7;
		return shiftDateKey(dayKey, -weekday);
	}
	return dayKey;
}

export function getBucketLabel(key, granularity) {
	if (granularity === "month") return new Date(`${key}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
	const label = new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	return granularity === "week" ? `Week of ${label}` : label;
}

// The buckets the range falls in, oldest first, each with the days of the range it holds.
export function buildBuckets(dayKeys, granularity) {
	const buckets = new Map();
	for (const day of dayKeys) {
		const key = getBucketKey(day, granularity);
		if (!buckets.has(key)) buckets.set(key, { key, label: getBucketLabel(key, granularity), days: 0 });
		buckets.get(key).days += 1;
	}
	return [...buckets.values()];
}

const SOURCE_LABELS = {
	website: "Website",
	popup: "Pop-up",
	gate: "Gated issue",
	"magic-link": "Magic Link",
	api: "API",
	dashboard: "Added by hand",
	import: "Import",
	referral: "Referral program",
	shop: "Shop",
	paid: "Paid subscription",
};

// formNames: form ID to name.
export function getSourceLabel(source, formNames = new Map()) {
	if (source === null || source === undefined || source === "") return "Unknown";
	if (source.startsWith("form:")) return `Form: ${formNames.get(source.slice(5)) ?? "deleted form"}`;
	if (source.startsWith("recommendation:")) return `Recommended by ${source.slice("recommendation:".length)}`;
	return SOURCE_LABELS[source] ?? source;
}

// What a row of the breakdown is called, and the key rows with the same name share. A contact from before FlockStack kept
// channels has the channel its source says.
export function getGroupIdentity(by, row, formNames) {
	if (by === "source") return { key: row.source ?? NONE_KEY, label: getSourceLabel(row.source, formNames) };
	if (by === "form") return row.source?.startsWith("form:") ? { key: row.source, label: getSourceLabel(row.source, formNames) } : null;
	if (by === "channel") {
		const channel = row.channel ?? classifyChannel({ source: row.source });
		return { key: channel, label: CHANNEL_LABELS[channel] ?? channel };
	}
	return { key: row.campaign ?? NONE_KEY, label: row.campaign ?? "No campaign" };
}

// The biggest groups by their count, the rest folded into one.
export function foldGroups(groups, limit = MAX_GROUPS) {
	const ranked = [...groups].sort((a, b) => b.new - a.new || a.label.localeCompare(b.label));
	if (ranked.length <= limit + 1) return ranked;
	const kept = ranked.slice(0, limit);
	const rest = ranked.slice(limit);
	const other = { key: OTHER_KEY, label: "Other", new: 0, active: 0, series: kept[0].series.map(() => 0) };
	for (const group of rest) {
		other.new += group.new;
		other.active += group.active;
		group.series.forEach((value, index) => (other.series[index] += value));
	}
	return [...kept, other];
}

export function toRate(part, total) {
	return total > 0 ? Math.round((part / total) * 10_000) / 10_000 : null;
}

// columns: [name, read(row)]. Cells are quoted and made safe for a spreadsheet (lib/contacts-csv.js).
export function toCsv(columns, rows) {
	const header = `${columns.map(([name]) => toCell(name)).join(",")}\r\n`;
	return header + rows.map((row) => `${columns.map(([, read]) => toCell(read(row))).join(",")}\r\n`).join("");
}
