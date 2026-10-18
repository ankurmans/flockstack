import { BUILT_IN_MERGE_TAGS, RESERVED_TAGS } from "./merge-tags.js";

// What a custom field's key and values look like, with nothing that touches the database (lib/custom-fields.js has the
// rest), so segment rules and the dashboard read them the same way.

export const MAX_FIELDS_PER_NEWSLETTER = 20;
export const MAX_TEXT_VALUE_LENGTH = 500;
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

// The value as stored for a field of that type: { value }, null to clear it, or { problem }. Dates are YYYY-MM-DD so
// they compare as text.
export function parseFieldValue(type, input) {
	if (input === null || input === undefined) return { value: null };
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
