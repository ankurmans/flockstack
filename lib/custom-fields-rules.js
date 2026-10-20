import { BUILT_IN_MERGE_TAGS, RESERVED_TAGS } from "./merge-tags.js";

// What a custom field's key and values look like, with nothing that touches the database (lib/custom-fields.js has the
// rest), so segment rules and the dashboard read them the same way.

// datetime: a moment, stored as an ISO string in UTC. boolean: true or false. list: one of the field's options, or
// with multiple, any of them (an array, kept in the options' order).
export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "datetime", "boolean", "list"];
export const MAX_FIELDS_PER_NEWSLETTER = 20;
export const MAX_TEXT_VALUE_LENGTH = 500;
export const MAX_LIST_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 60;
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off"]);
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
// Keys that mean something else in a merge tag, a CSV column or a segment.
const RESERVED_KEYS = new Set([...RESERVED_TAGS, ...BUILT_IN_MERGE_TAGS, "tags", "status", "source", "newsletter"]);

// "First name" or "first-name" -> first_name.
export function slugifyFieldKey(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 30);
}

export function getFieldKeyProblem(key) {
	if (!FIELD_KEY_PATTERN.test(key)) return "key: use lowercase letters, digits and underscores, starting with a letter, 30 at most";
	if (RESERVED_KEYS.has(key)) return `${key} is reserved: pick another key`;
	return null;
}

// A list field's options: trimmed, each once, without commas, since a CSV cell lists several with them.
export function getOptionsProblem(options) {
	if (!Array.isArray(options) || options.length < 1) return "options: a list field needs at least one option";
	if (options.length > MAX_LIST_OPTIONS) return `options: ${MAX_LIST_OPTIONS} at most`;
	const seen = new Set();
	for (const option of options) {
		const text = String(option ?? "").trim();
		if (!text || text.length > MAX_OPTION_LENGTH) return `options: each has 1 to ${MAX_OPTION_LENGTH} characters`;
		if (text.includes(",")) return "options: an option can't contain a comma";
		if (seen.has(text.toLowerCase())) return `options: ${text} is there twice`;
		seen.add(text.toLowerCase());
	}
	return null;
}

function parseList(input, { options = [], multiple = false }) {
	const byName = new Map(options.map((option) => [option.toLowerCase(), option]));
	const items = (Array.isArray(input) ? input : String(input).split(",")).map((item) => String(item ?? "").trim()).filter(Boolean);
	if (items.length === 0) return { value: null };
	if (!multiple && items.length > 1) return { problem: "takes one option" };
	const unknown = items.find((item) => !byName.has(item.toLowerCase()));
	if (unknown !== undefined) return { problem: `must be one of ${options.join(", ")}` };
	if (!multiple) return { value: byName.get(items[0].toLowerCase()) };
	const chosen = new Set(items.map((item) => byName.get(item.toLowerCase())));
	return { value: options.filter((option) => chosen.has(option)) };
}

function parseDateTime(input) {
	const text = input instanceof Date ? input.toISOString() : String(input).trim();
	if (!text) return { value: null };
	// Without a zone (a datetime-local input, a spreadsheet), the time is read as UTC.
	const zoned = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
	const date = new Date(zoned);
	return Number.isFinite(date.getTime()) ? { value: date.toISOString() } : { problem: "must be a date and time like 2026-03-14T09:30:00Z" };
}

// The value as stored for a field of that type: { value }, null to clear it, or { problem }. Dates are YYYY-MM-DD and
// date-times ISO strings in UTC, so both compare as text. field: the definition, for a list field's options.
export function parseFieldValue(type, input, field = {}) {
	if (input === null || input === undefined) return { value: null };
	if (type === "boolean") {
		if (typeof input === "boolean") return { value: input };
		const word = String(input).trim().toLowerCase();
		if (!word) return { value: null };
		if (TRUE_WORDS.has(word)) return { value: true };
		return FALSE_WORDS.has(word) ? { value: false } : { problem: "must be true or false" };
	}
	if (type === "datetime") return parseDateTime(input);
	if (type === "list") return parseList(input, field);
	if (type === "number") {
		if (typeof input === "string" && input.trim() === "") return { value: null };
		const number = typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;
		return Number.isFinite(number) ? { value: number } : { problem: "must be a number" };
	}
	if (type === "date") {
		if (typeof input === "string" && input.trim() === "") return { value: null };
		const text = input instanceof Date ? input.toISOString() : String(input).trim();
		const day = /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
		const date = new Date(day ? `${day}T00:00:00Z` : text);
		if (!Number.isFinite(date.getTime())) return { problem: "must be a date like 2026-03-14" };
		const value = day ?? date.toISOString().slice(0, 10);
		// 2026-02-31 parses in some engines as March 3: only real days count.
		return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? { value } : { problem: "must be a real date like 2026-03-14" };
	}
	const text = String(input).trim();
	if (!text) return { value: null };
	return text.length <= MAX_TEXT_VALUE_LENGTH ? { value: text } : { problem: `must be ${MAX_TEXT_VALUE_LENGTH} characters or fewer` };
}
