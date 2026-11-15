import { CONTACT_DATA_READS, getActionClass } from "./action-scopes.js";

// What the agent activity log keeps and for how long (lib/agent-activity.js). The log is a place where a leak would hurt:
// it holds ids, names and counts, never the text of an input.
export const ACTIVITY_RETENTION_DAYS = 90;
// What the owner can choose instead. A fixed few, so the hourly purge is one bounded delete per choice: each entry carries the
// choice it was written under (keepDays), and changing it rewrites the account's entries. 365 is the most because D1 has a size cap.
export const ACTIVITY_RETENTION_CHOICES = [30, 90, 180, 365];
export const MAX_ACTIVITY_RETENTION_DAYS = 365;
// Rows the hourly purge deletes at most per retention choice and per table in one run; the next run takes the rest.
export const ACTIVITY_PURGE_PER_RUN = 5000;
// Rows one CSV export holds at most: a longer range is exported in parts with its days and filters.
export const ACTIVITY_EXPORT_LIMIT = 10_000;

// The account's retention in days: the owner's choice, else the default.
export function getRetentionDays(account) {
	return ACTIVITY_RETENTION_CHOICES.includes(account?.agentActivityRetentionDays) ? account.agentActivityRetentionDays : ACTIVITY_RETENTION_DAYS;
}

const CSV_COLUMNS = ["at", "kind", "actorType", "actorId", "actorName", "via", "action", "className", "newsletterId", "status", "errorCode", "summary", "requestId", "approvalId"];

// A spreadsheet cell: quoted, and a leading = + - @ made text so no spreadsheet runs it as a formula.
function toCsvCell(value) {
	const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
	const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
	return `"${safe.replaceAll('"', '""')}"`;
}

// Entries as the activity log's rows, as CSV with a header line.
export function toActivityCsv(rows) {
	const lines = rows.map((row) => CSV_COLUMNS.map((column) => toCsvCell(column === "at" ? row.createdAt : row[column])).join(","));
	return `${CSV_COLUMNS.join(",")}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}
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
		// key: an AI provider's key (add_ai_key), which no log may hold, whatever it looks like.
		if (["key", "secret", "body", "prompt", "content", "text", "subject", "previewText", "title", "description", "name", "notes", "writingBrief", "hook", "callToAction"].includes(key)) continue;
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
