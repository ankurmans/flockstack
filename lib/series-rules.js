import { FEED_BLOCK } from "./editor-blocks.js";
import { getFeedUrlProblem } from "./feed-url.js";
import { formatFeedDate } from "./feed-render.js";
import { hourIn, shiftDateKey, startOfDateKey, toDateKey } from "./time-zone.js";

// A recurring series (models/SeriesPlan.js): on a schedule, an issue made of the feed's new items. The rules are here so
// the dashboard's form, the actions and the job read them from one place.
export const SERIES_FREQUENCIES = ["daily", "weekly", "monthly"];
export const SERIES_MODES = ["draft", "send"];
export const SERIES_RUN_STATUSES = ["running", "drafted", "sent", "skipped", "failed"];
export const MAX_SERIES_PER_NEWSLETTER = 10;
export const MAX_SERIES_INTRO_LENGTH = 20_000;
export const MAX_SEEN_IDS = 200;
export const SERIES_TEMPLATE_TAGS = ["{{date}}", "{{first_title}}", "{{count}}"];
export const DEFAULT_SCHEDULE = { frequency: "weekly", days: [1], dayOfMonth: 1, hour: 8, timeZone: "UTC" };
const HOUR_MS = 3_600_000;
const SEARCH_DAYS = 62;
const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// The time zone's own name (Europe/Paris, UTC) for any spelling of it, or null when there is no such zone.
export function normalizeTimeZone(value) {
	if (value === undefined || value === null || value === "") return "UTC";
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: String(value).slice(0, 64) }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

function isWithin(value, min, max) {
	return Number.isInteger(value) && value >= min && value <= max;
}

// What is wrong with a series' settings, or null.
export function getSeriesProblem(settings) {
	if (!settings.name?.trim()) return "Name the series";
	const feedProblem = getFeedUrlProblem(settings.feedUrl);
	if (feedProblem) return feedProblem;
	if (!settings.subject?.trim()) return "Write the subject line";
	if (settings.subject.length > 200) return "The subject can be 200 characters at most";
	if ((settings.previewText ?? "").length > 300) return "The preview text can be 300 characters at most";
	if (!SERIES_MODES.includes(settings.mode)) return "Choose to send automatically or to draft for review";
	if (!isWithin(settings.count, 1, FEED_BLOCK.maxCount)) return `Show 1 to ${FEED_BLOCK.maxCount} items`;
	if ((settings.intro ?? "").length > MAX_SERIES_INTRO_LENGTH) return "The introduction is too long";
	const { schedule } = settings;
	if (!SERIES_FREQUENCIES.includes(schedule?.frequency)) return "Choose daily, weekly or monthly";
	if (!isWithin(schedule.hour, 0, 23)) return "Pick an hour from 0 to 23";
	if (schedule.frequency === "weekly" && !(schedule.days?.length > 0 && schedule.days.every((day) => isWithin(day, 0, 6)))) return "Pick the days of the week";
	if (schedule.frequency === "monthly" && !isWithin(schedule.dayOfMonth, 1, 28)) return "Pick a day of the month from 1 to 28, which every month has";
	if (!normalizeTimeZone(schedule.timeZone)) return "That time zone isn't one FlockStack knows";
	return null;
}

function runsOn(schedule, dateKey) {
	const date = new Date(`${dateKey}T12:00:00Z`);
	if (schedule.frequency === "daily") return true;
	if (schedule.frequency === "weekly") return schedule.days.includes(date.getUTCDay());
	return date.getUTCDate() === schedule.dayOfMonth;
}

// The first moment after `after` when the schedule is due: its hour in its time zone, on a day it runs.
export function getNextRun(schedule, after = new Date()) {
	const timeZone = normalizeTimeZone(schedule.timeZone) ?? "UTC";
	const today = toDateKey(after, timeZone);
	for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
		const key = shiftDateKey(today, offset);
		if (!runsOn(schedule, key)) continue;
		let time = startOfDateKey(key, timeZone).getTime() + schedule.hour * HOUR_MS;
		// A day that gains or loses an hour puts the wall clock off by that much.
		time += (schedule.hour - hourIn(new Date(time), timeZone)) * HOUR_MS;
		if (time > after.getTime()) return new Date(time);
	}
	return null;
}

// "Weekly on Mondays and Thursdays at 08:00 (Europe/Paris)"
export function describeSchedule(schedule) {
	const at = `${String(schedule.hour).padStart(2, "0")}:00 (${schedule.timeZone || "UTC"})`;
	if (schedule.frequency === "daily") return `Every day at ${at}`;
	if (schedule.frequency === "monthly") return `Monthly on day ${schedule.dayOfMonth} at ${at}`;
	const days = [...schedule.days].sort((a, b) => a - b).map((day) => WEEKDAYS[day]);
	return `Weekly on ${days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : days[0]} at ${at}`;
}

// {{date}} (the day it runs, in the series' time zone), {{first_title}} (the title of the issue's first item) and {{count}}
// (how many items). Any other {{tag}} stays, for the merge tags every email fills in.
export function fillSeriesTemplate(template, { date, firstTitle = "", count = 0, timeZone = "UTC" }) {
	const day = formatFeedDate(new Date(`${toDateKey(date, normalizeTimeZone(timeZone) ?? "UTC")}T12:00:00Z`));
	return String(template ?? "")
		.replaceAll("{{date}}", day)
		.replaceAll("{{first_title}}", firstTitle)
		.replaceAll("{{count}}", String(count));
}
