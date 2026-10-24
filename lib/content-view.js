import { CONTENT_CHANNELS, CONTENT_STATES, FUNNEL_STAGES, isDateKey } from "@/lib/content-rules";
import { isMonthKey } from "@/lib/calendar";
import { shiftDateKey } from "@/lib/time-zone";
import { isObjectIdString } from "@/lib/validation";

// What the calendar page reads from its address and how it words and links what it shows. No imports of the server: the
// page and its components share it.

export const VIEWS = ["month", "week", "agenda"];
export const VIEW_LABELS = { month: "Month", week: "Week", agenda: "Agenda" };

// What an entry is called on the calendar. Planned is an intent; the others are the campaign's own delivery.
export const KIND_LABELS = { planned: "Planned", scheduled: "Scheduled", sending: "Sending", paused: "Paused", sent: "Sent" };

// Planned is outlined, never filled, so a plan can't be mistaken for a delivery.
export const KIND_STYLES = {
	planned: "border border-dashed border-foreground/40 text-foreground",
	scheduled: "bg-amber-500/15 text-amber-900 dark:text-amber-200",
	sending: "bg-sky-500/15 text-sky-900 dark:text-sky-200",
	paused: "bg-orange-500/15 text-orange-900 dark:text-orange-200",
	sent: "bg-muted text-foreground",
};

export function getEntryLabel(entry) {
	if (entry.kind === "planned" && entry.state === "delivered") return entry.isManual ? "Posted by hand" : "Delivered";
	return KIND_LABELS[entry.kind];
}

// An entry's page in the dashboard: its content item, else its campaign.
export function getEntryHref(entry) {
	return entry.itemId ? `/campaigns/calendar/items/${entry.itemId}` : `/campaigns/${entry.campaignId}`;
}

export function readView(value) {
	return VIEWS.includes(value) ? value : "month";
}

// The filters in the address, those that are a known value.
export function readFilters(params = {}) {
	const one = (value) => (typeof value === "string" ? value : "");
	return {
		channel: CONTENT_CHANNELS.includes(params.channel) ? params.channel : "",
		funnelStage: FUNNEL_STAGES.includes(params.stage) ? params.stage : "",
		state: CONTENT_STATES.includes(params.state) ? params.state : "",
		batch: isObjectIdString(one(params.batch)) ? params.batch : "",
		pillar: one(params.pillar).trim().slice(0, 60),
	};
}

export function hasFilters(filters) {
	return Object.values(filters).some(Boolean);
}

// The calendar's address: only what differs from the default is in it, month first.
export function getCalendarHref({ view = "month", month, date, filters = {} } = {}) {
	const query = new URLSearchParams();
	if (month) query.set("month", month);
	if (view !== "month") query.set("view", view);
	if (date) query.set("date", date);
	for (const [key, name] of [["channel", "channel"], ["funnelStage", "stage"], ["state", "state"], ["batch", "batch"], ["pillar", "pillar"]]) {
		if (filters[key]) query.set(name, filters[key]);
	}
	const text = query.toString();
	return `/campaigns/calendar${text ? `?${text}` : ""}`;
}

export function readDate(value, fallback) {
	return isDateKey(value) ? value : fallback;
}

// The Monday of the week a day is in.
export function getWeekStart(dateKey) {
	const weekday = (new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7;
	return shiftDateKey(dateKey, -weekday);
}

export function monthOf(dateKey) {
	return isMonthKey(dateKey.slice(0, 7)) ? dateKey.slice(0, 7) : dateKey;
}

export function groupByDay(entries) {
	const days = new Map();
	for (const entry of entries) days.set(entry.date, [...(days.get(entry.date) ?? []), entry]);
	return days;
}
