import * as z from "zod";
import { parseFieldValue } from "./custom-fields-rules.js";
import { normalizeTag } from "./tag-rules.js";

// A segment's rules: conditions on a newsletter's contacts joined by all (and) or any (or). A condition can also be a
// group of conditions with its own all or any, one level deep, so "active and (tagged vip or opened lately)" fits.
// The rules compile to the filter of lib/docdb, and every condition runs in the database (tests/segments.test.mjs
// checks that none leaves a rest for JavaScript).

export const CONTACT_STATUS_VALUES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];
export const CONDITION_TYPES = ["status", "tag", "field", "signup_date", "source", "engagement", "imported"];
export const FIELD_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "includes", "excludes", "is_set", "is_not_set"];
// The ops each type of field takes, past is_set and is_not_set.
const OPS_BY_TYPE = {
	text: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with"],
	number: ["eq", "neq", "gt", "gte", "lt", "lte"],
	date: ["eq", "neq", "gt", "gte", "lt", "lte"],
	datetime: ["eq", "neq", "gt", "gte", "lt", "lte"],
	boolean: ["eq", "neq"],
	list: ["eq", "neq", "includes", "excludes"],
};
export const ENGAGEMENT_KINDS = ["opened", "clicked", "opened_or_clicked", "never_opened", "dormant"];
export const MAX_CONDITIONS = 20;
export const MAX_SEGMENTS_PER_NEWSLETTER = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

const conditionSchema = z.object({
	type: z.enum(CONDITION_TYPES).describe("What the condition looks at"),
	op: z
		.enum(["is", "is_not", "has", "has_not", ...FIELD_OPS])
		.optional()
		.describe(
			"status and source: is or is_not (default is). tag: has or has_not (default has). field: eq, neq, gt, gte, lt, lte, contains, starts_with (text only), includes or excludes (list fields: has the option among its choices), is_set or is_not_set. A boolean field takes eq and neq."
		),
	value: z
		.union([z.string().max(500), z.number(), z.boolean()])
		.optional()
		.describe(
			"status: a contact status. tag: the tag. source: where they signed up. field: what to compare to (a number for number fields, YYYY-MM-DD for dates, an ISO date and time for datetime fields, true or false, a list field's option). imported: true or false (default true)."
		),
	field: z.string().max(30).optional().describe("field: the custom field's key"),
	from: z.string().max(40).optional().describe("signup_date: the first day, e.g. 2026-01-01"),
	to: z.string().max(40).optional().describe("signup_date: the last day, included"),
	kind: z
		.enum(ENGAGEMENT_KINDS)
		.optional()
		.describe(
			"engagement. opened, clicked, opened_or_clicked: in the last days days. never_opened: got at least one email and never opened one. dormant: subscribed over days days ago and no opens or clicks since."
		),
	days: z.number().int().min(1).max(3650).optional().describe("engagement: how many days back"),
});

const groupSchema = z.object({
	match: z.enum(["all", "any"]).describe("all: every condition of the group has to hold. any: one is enough."),
	conditions: z.array(conditionSchema).min(1).max(MAX_CONDITIONS).describe("The group's conditions"),
});

export const SegmentRulesSchema = z.object({
	match: z.enum(["all", "any"]).describe("all: every condition (or group) has to hold. any: one is enough."),
	conditions: z
		.array(z.union([conditionSchema, groupSchema]))
		.min(1)
		.max(MAX_CONDITIONS)
		.describe("Conditions, or groups of conditions (a group has match and conditions and no type)"),
});

function problem(message) {
	return { problem: message };
}

function isGroup(item) {
	return Array.isArray(item?.conditions);
}

function readDay(text, { isEnd = false } = {}) {
	const value = String(text ?? "").trim();
	if (!value) return null;
	const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
	const date = new Date(day ? `${value}T${isEnd ? "23:59:59.999" : "00:00:00.000"}Z` : value);
	return Number.isFinite(date.getTime()) ? date : null;
}

// fieldTypes: custom field key to its type, or to the field ({ type, options, multiple }). Returns { condition } with the
// value in its stored form, or { problem }.
export function checkCondition(condition, fieldTypes) {
	switch (condition.type) {
		case "status": {
			const op = condition.op ?? "is";
			if (!["is", "is_not"].includes(op)) return problem("status: op is is or is_not");
			if (!CONTACT_STATUS_VALUES.includes(condition.value)) return problem(`status: value is one of ${CONTACT_STATUS_VALUES.join(", ")}`);
			return { condition: { type: "status", op, value: condition.value } };
		}
		case "tag": {
			const op = condition.op ?? "has";
			if (!["has", "has_not"].includes(op)) return problem("tag: op is has or has_not");
			const value = normalizeTag(condition.value);
			if (!value) return problem("tag: value is a tag, e.g. vip");
			return { condition: { type: "tag", op, value } };
		}
		case "source": {
			const op = condition.op ?? "is";
			if (!["is", "is_not"].includes(op)) return problem("source: op is is or is_not");
			if (typeof condition.value !== "string" || !condition.value.trim()) return problem("source: value is where they signed up, e.g. website");
			return { condition: { type: "source", op, value: condition.value.trim() } };
		}
		case "field": {
			const entry = fieldTypes.get(condition.field);
			if (!entry) return problem(`field: the newsletter has no custom field ${JSON.stringify(condition.field ?? "")}`);
			const definition = typeof entry === "string" ? { type: entry } : entry;
			const { type } = definition;
			if (!FIELD_OPS.includes(condition.op)) return problem(`field: op is one of ${FIELD_OPS.join(", ")}`);
			if (["is_set", "is_not_set"].includes(condition.op)) return { condition: { type: "field", field: condition.field, op: condition.op } };
			if (["contains", "starts_with"].includes(condition.op) && type !== "text") return problem(`field: ${condition.op} works on text fields`);
			if (!(OPS_BY_TYPE[type] ?? OPS_BY_TYPE.text).includes(condition.op)) {
				return problem(`field: a ${type} field takes ${[...OPS_BY_TYPE[type], "is_set", "is_not_set"].join(", ")}`);
			}
			// A condition names one option, even on a field that holds several.
			const parsed = parseFieldValue(type, condition.value, { ...definition, multiple: false });
			if (parsed.problem || parsed.value === null) return problem(`field ${condition.field}: value ${parsed.problem ?? "is needed"}`);
			return { condition: { type: "field", field: condition.field, op: condition.op, value: parsed.value } };
		}
		case "signup_date": {
			const from = condition.from ? readDay(condition.from) : null;
			const to = condition.to ? readDay(condition.to) : null;
			if ((condition.from && !from) || (condition.to && !to)) return problem("signup_date: from and to are dates like 2026-01-31");
			if (!from && !to) return problem("signup_date: give from, to or both");
			if (from && to && from > to) return problem("signup_date: from is after to");
			return { condition: { type: "signup_date", ...(condition.from && { from: condition.from }), ...(condition.to && { to: condition.to }) } };
		}
		case "engagement": {
			if (!ENGAGEMENT_KINDS.includes(condition.kind)) return problem(`engagement: kind is one of ${ENGAGEMENT_KINDS.join(", ")}`);
			if (condition.kind === "never_opened") return { condition: { type: "engagement", kind: "never_opened" } };
			if (!Number.isInteger(condition.days) || condition.days < 1) return problem("engagement: days is how many days back, 1 or more");
			return { condition: { type: "engagement", kind: condition.kind, days: condition.days } };
		}
		case "imported":
			return { condition: { type: "imported", value: condition.value !== false } };
		default:
			return problem(`type is one of ${CONDITION_TYPES.join(", ")}`);
	}
}

// Rules as the schema parsed them -> rules ready to store, or { problem }. Every value is in its stored form after this,
// so compiling needs nothing but the rules.
export function checkRules(rules, fieldTypes) {
	const checked = [];
	for (const item of rules.conditions) {
		if (isGroup(item)) {
			const group = [];
			for (const condition of item.conditions) {
				const result = checkCondition(condition, fieldTypes);
				if (result.problem) return result;
				group.push(result.condition);
			}
			checked.push({ match: item.match, conditions: group });
		} else {
			const result = checkCondition(item, fieldTypes);
			if (result.problem) return result;
			checked.push(result.condition);
		}
	}
	return { rules: { match: rules.match, conditions: checked } };
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileEngagement({ kind, days }, now) {
	const cutoff = new Date(now.getTime() - days * DAY_MS);
	switch (kind) {
		case "opened":
			return { lastOpenAt: { $gte: cutoff } };
		case "clicked":
			return { lastClickAt: { $gte: cutoff } };
		case "opened_or_clicked":
			return { $or: [{ lastOpenAt: { $gte: cutoff } }, { lastClickAt: { $gte: cutoff } }] };
		case "never_opened":
			return { "stats.sent": { $gt: 0 }, lastOpenAt: null };
		default:
			return {
				$and: [
					{ subscribedAt: { $lt: cutoff } },
					{ $or: [{ lastOpenAt: null }, { lastOpenAt: { $lt: cutoff } }] },
					{ $or: [{ lastClickAt: null }, { lastClickAt: { $lt: cutoff } }] },
				],
			};
	}
}

// A list field with several choices holds an array, and like Mongo the database matches a value against any of its
// items (lib/docdb/sql.js), so includes and excludes are eq and neq.
function compileField({ field, op, value }) {
	const path = `fields.${field}`;
	switch (op) {
		case "eq":
		case "includes":
			return { [path]: value };
		case "neq":
		case "excludes":
			return { [path]: { $ne: value } };
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return { [path]: { [`$${op}`]: value } };
		case "contains":
			return { [path]: { $regex: escapeRegex(value) } };
		case "starts_with":
			return { [path]: { $regex: `^${escapeRegex(value)}` } };
		case "is_set":
			return { [path]: { $exists: true } };
		default:
			return { [path]: { $exists: false } };
	}
}

export function compileCondition(condition, now = new Date()) {
	switch (condition.type) {
		case "status":
			return { status: condition.op === "is_not" ? { $ne: condition.value } : condition.value };
		case "tag":
			return { tags: condition.op === "has_not" ? { $ne: condition.value } : condition.value };
		case "source":
			return { source: condition.op === "is_not" ? { $ne: condition.value } : condition.value };
		case "field":
			return compileField(condition);
		case "signup_date": {
			const range = {
				...(condition.from && { $gte: readDay(condition.from) }),
				...(condition.to && { $lte: readDay(condition.to, { isEnd: true }) }),
			};
			return { subscribedAt: range };
		}
		case "engagement":
			return compileEngagement(condition, now);
		default:
			return { importId: { $exists: condition.value !== false } };
	}
}

// The filter for the contacts a segment matches, to put next to the account and newsletter. now: for "in the last N days".
export function compileRules(rules, now = new Date()) {
	const parts = rules.conditions.map((item) =>
		isGroup(item)
			? { [item.match === "any" ? "$or" : "$and"]: item.conditions.map((condition) => compileCondition(condition, now)) }
			: compileCondition(item, now)
	);
	return { [rules.match === "any" ? "$or" : "$and"]: parts };
}

const STATUS_NAMES = { is: "is", is_not: "is not" };
const OP_NAMES = {
	eq: "is",
	neq: "is not",
	gt: "is above",
	gte: "is at least",
	lt: "is below",
	lte: "is at most",
	contains: "contains",
	starts_with: "starts with",
	includes: "includes",
	excludes: "doesn't include",
	is_set: "has a value",
	is_not_set: "has no value",
};
const ENGAGEMENT_NAMES = {
	opened: (days) => `opened in the last ${days} days`,
	clicked: (days) => `clicked in the last ${days} days`,
	opened_or_clicked: (days) => `opened or clicked in the last ${days} days`,
	never_opened: () => "never opened an email",
	dormant: (days) => `no opens or clicks in ${days} days`,
};

// One condition in words, for lists and summaries.
export function describeCondition(condition) {
	switch (condition.type) {
		case "status":
			return `Status ${STATUS_NAMES[condition.op]} ${condition.value}`;
		case "tag":
			return `${condition.op === "has_not" ? "Doesn't have" : "Has"} the tag ${condition.value}`;
		case "source":
			return `Source ${STATUS_NAMES[condition.op]} ${condition.value}`;
		case "field":
			return `${condition.field} ${OP_NAMES[condition.op]}${condition.value === undefined ? "" : ` ${condition.value}`}`;
		case "signup_date":
			return `Signed up ${condition.from ? `from ${condition.from} ` : ""}${condition.to ? `to ${condition.to}` : ""}`.trim();
		case "engagement":
			return ENGAGEMENT_NAMES[condition.kind](condition.days);
		default:
			return condition.value === false ? "Not imported" : "Imported";
	}
}

export function describeRules(rules) {
	const join = rules.match === "any" ? " or " : " and ";
	return rules.conditions
		.map((item) => (isGroup(item) ? `(${item.conditions.map(describeCondition).join(item.match === "any" ? " or " : " and ")})` : describeCondition(item)))
		.join(join);
}
