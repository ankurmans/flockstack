import { CONTACT_DATA_READS, getActionClass } from "./action-scopes.js";

// What the agent activity log keeps and for how long (lib/agent-activity.js). The log is a place where a leak would hurt:
// it holds ids, names and counts, never the text of an input.
export const ACTIVITY_RETENTION_DAYS = 90;
export const MAX_SUMMARY_LENGTH = 240;

const OBJECT_ID = /^[a-f0-9]{24}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,98}$/;
// Strings that name an option, never a person's words.
const OPTION_FIELDS = new Set(["status", "operation", "action", "audience", "mode", "level", "type", "decision", "format", "publishTo", "duplicates", "interval", "plan", "kind"]);
const OPTION_VALUE = /^[a-z_]{1,24}$/;

// A line for the log from an action's input: ids, options, numbers, and how many items each list has.
export function summarizeCall(action, input = {}) {
	const parts = [];
	for (const [key, value] of Object.entries(input ?? {})) {
		if (Array.isArray(value)) parts.push(`${key}: ${value.length}`);
		else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}: ${value}`);
		else if (typeof value === "string") {
			if (OBJECT_ID.test(value)) parts.push(`${key}: ${value}`);
			else if (key === "newsletter" && SLUG.test(value)) parts.push(`${key}: ${value}`);
			else if (OPTION_FIELDS.has(key) && OPTION_VALUE.test(value)) parts.push(`${key}: ${value}`);
		}
	}
	return `${action.title}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`.slice(0, MAX_SUMMARY_LENGTH);
}

// Whether a call goes in the log: it changes something, or it shows contact data. Other reads are only counted in AgentDay.
export function isLoggedCall(action, input) {
	const className = getActionClass(action.name, input);
	return className !== "read" || CONTACT_DATA_READS.includes(action.name);
}

// YYYY-MM-DD in UTC: the day a call counts in.
export function getDay(date = new Date()) {
	return new Date(date).toISOString().slice(0, 10);
}
