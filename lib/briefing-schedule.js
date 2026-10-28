import { shiftDateKey, toDateKey, zonedTimeToInstant } from "./time-zone.js";

// A briefing's schedule (models/Briefing.js): weekdays 1 (Monday) to 7 (Sunday), a wall-clock time and an IANA time zone. Plain
// JavaScript that imports only lib/time-zone.js, so the actions, the dashboard and the engine (lib/briefings/) read the same rules.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

// The time zone's own name (Europe/Paris, UTC) for any spelling of it, or null when there is no such zone.
export function normalizeBriefingTimeZone(value) {
	if (value === undefined || value === null || value === "") return "UTC";
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: String(value).slice(0, 64) }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

// What is wrong with a schedule, or null.
export function getBriefingScheduleProblem(schedule) {
	const days = schedule?.days;
	if (!Array.isArray(days) || days.length === 0 || !days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return "Pick the days of the week it runs";
	if (!TIME_PATTERN.test(String(schedule.time ?? ""))) return "Pick a time as HH:MM, 00:00 to 23:59";
	if (!normalizeBriefingTimeZone(schedule.timeZone)) return "That time zone isn't one FlockStack knows";
	return null;
}

// The schedule as it is stored: days sorted once each, the zone's own name.
export function normalizeBriefingSchedule(schedule) {
	return {
		days: [...new Set(schedule.days)].sort((a, b) => a - b),
		time: schedule.time,
		timeZone: normalizeBriefingTimeZone(schedule.timeZone) ?? "UTC",
	};
}

// 1 (Monday) to 7 (Sunday) for a YYYY-MM-DD day.
function weekdayOf(dateKey) {
	return new Date(`${dateKey}T12:00:00Z`).getUTCDay() || 7;
}

// The first moment after `after` when the schedule is due: its time in its time zone, on a day it runs. A time the clock skips
// on a daylight saving change runs just after the gap. null for a schedule with no days.
export function nextBriefingRunAt(schedule, after = new Date()) {
	if (getBriefingScheduleProblem(schedule)) return null;
	const timeZone = normalizeBriefingTimeZone(schedule.timeZone);
	const today = toDateKey(after, timeZone);
	// From yesterday: in a zone behind UTC the local day can still be the one before.
	for (let offset = -1; offset <= 8; offset += 1) {
		const key = shiftDateKey(today, offset);
		if (!schedule.days.includes(weekdayOf(key))) continue;
		const at = zonedTimeToInstant(key, schedule.time, timeZone);
		if (at.getTime() > after.getTime()) return at;
	}
	return null;
}

// The local day a run due at `dueAt` belongs to, which is its slot (models/BriefingRun.js): one run per briefing per day.
export function getBriefingSlot(schedule, dueAt) {
	return toDateKey(dueAt, normalizeBriefingTimeZone(schedule?.timeZone) ?? "UTC");
}

// "Mondays and Thursdays at 06:00 (Europe/Paris)", "Every day at 06:00 (UTC)"
export function describeBriefingSchedule(schedule) {
	const at = `at ${schedule.time} (${schedule.timeZone || "UTC"})`;
	const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
	if (days.length === 7) return `Every day ${at}`;
	if (days.join() === "1,2,3,4,5") return `Weekdays ${at}`;
	const names = days.map((day) => WEEKDAYS[day - 1]);
	return `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "Never")} ${at}`;
}
