import * as z from "zod";
import { parseFieldValue } from "./custom-fields-rules.js";
import { normalizeTag } from "./tag-rules.js";
import { audienceTierFilter } from "./tiers.js";

// A segment's rules: conditions on a newsletter's contacts joined by all (and) or any (or). A condition can also be a
// group of conditions with its own all or any, one level deep, so "active and (tagged vip or opened lately)" fits.
// The rules compile to the filter of lib/docdb, and every condition runs in the database (tests/segments.test.mjs
// checks that none leaves a rest for JavaScript). One engine serves segments, campaign audiences and the branches of
// automations (lib/automations.js).
//
// A condition about another collection (who opened an issue, who is on a saved list) can't be a join: lib/segments.js
// loadLookups reads those contacts' IDs first, and compileRules turns them into an _id filter.

export const CONTACT_STATUS_VALUES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];
export const CONDITION_TYPES = ["status", "tag", "field", "signup_date", "source", "engagement", "imported", "poll", "tier", "country", "referrals", "issue", "snapshot"];
const POLL_OPS = ["is", "is_not", "is_any_of", "is_none_of", "is_set", "is_not_set"];
const SET_OPS = ["is_any_of", "is_none_of"];
export const MAX_VALUES = 25;
export const MAX_TOTAL_CONDITIONS = 40;
export const MAX_LOOKUP_CONDITIONS = 5;
// IDs per bound parameter: D1 takes strings up to 2 MB, and a statement binds at most 100 parameters.
export const LOOKUP_CHUNK = 30_000;
export const MAX_LOOKUP_CONTACTS = 150_000;
export const ISSUE_ACTIONS = ["opened", "clicked", "not_opened", "not_clicked"];
export const CONTACT_TIER_VALUES = ["free", "paid"];
export const FIELD_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "includes", "excludes", "is_any_of", "is_none_of", "is_set", "is_not_set"];
// The ops each type of field takes, past is_set and is_not_set.
const OPS_BY_TYPE = {
	text: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "is_any_of", "is_none_of"],
	number: ["eq", "neq", "gt", "gte", "lt", "lte", "is_any_of", "is_none_of"],
	date: ["eq", "neq", "gt", "gte", "lt", "lte", "is_any_of", "is_none_of"],
	datetime: ["eq", "neq", "gt", "gte", "lt", "lte"],
	boolean: ["eq", "neq"],
	list: ["eq", "neq", "includes", "excludes", "is_any_of", "is_none_of"],
};
export const ENGAGEMENT_KINDS = ["opened", "clicked", "opened_or_clicked", "never_opened", "dormant"];
export const MAX_CONDITIONS = 20;
export const MAX_SEGMENTS_PER_NEWSLETTER = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

const conditionSchema = z.object({
	type: z.enum(CONDITION_TYPES).describe("What the condition looks at"),
	op: z
		.enum(["is", "is_not", "has", "has_not", ...SET_OPS, ...FIELD_OPS])
		.optional()
		.describe(
			"status, source, country and tier: is or is_not (default is); status, source and country also take is_any_of and is_none_of with values. tag: has or has_not (default has), or is_any_of (has at least one of values) and is_none_of (has none of them). poll: is or is_not an answer, is_any_of or is_none_of with options, is_set (voted) or is_not_set (didn't vote from an email). field: eq, neq, gt, gte, lt, lte, contains, starts_with (text only), includes or excludes (list fields: has the option among its choices), is_any_of or is_none_of with values (not true or false and date and time fields), is_set or is_not_set. A boolean field takes eq and neq. referrals: eq, neq, gt, gte, lt or lte a number of credited referrals."
		),
	value: z
		.union([z.string().max(500), z.number(), z.boolean()])
		.optional()
		.describe(
			"status: a contact status. tag: the tag. source: where they signed up. country: a two-letter country code, e.g. US. tier: free or paid. referrals: how many referrals. field: what to compare to (a number for number fields, YYYY-MM-DD for dates, an ISO date and time for datetime fields, true or false, a list field's option). imported: true or false (default true)."
		),
	values: z
		.array(z.union([z.string().max(500), z.number()]))
		.min(1)
		.max(MAX_VALUES)
		.optional()
		.describe(`status, tag, source, country and field with is_any_of or is_none_of: the values, up to ${MAX_VALUES}`),
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
	poll: z.string().max(24).optional().describe("poll: the poll's ID"),
	option: z.number().int().min(0).max(9).optional().describe("poll: the answer, 0 for the first"),
	options: z.array(z.number().int().min(0).max(9)).min(1).max(10).optional().describe("poll with is_any_of or is_none_of: the answers, 0 for the first"),
	question: z.string().optional().describe("poll: the poll's question and answer, filled in by FlockStack for the summary"),
	answer: z.string().optional().describe("poll: the answer's label, filled in by FlockStack"),
	answers: z.array(z.string()).optional().describe("poll with is_any_of or is_none_of: the answers' labels, filled in by FlockStack"),
	campaign: z.string().max(24).optional().describe("issue: the issue's (campaign's) ID"),
	action: z
		.enum(ISSUE_ACTIONS)
		.optional()
		.describe("issue: opened or clicked the issue, or not_opened and not_clicked: got it and didn't. Readers who never got the issue match none of the four."),
	link: z.number().int().min(0).max(999).optional().describe("issue with clicked or not_clicked: only this link, by its place in the issue (the report lists them from 0)"),
	url: z.string().max(2000).optional().describe("issue with clicked or not_clicked: only links with this address, instead of link"),
	links: z.array(z.number().int()).optional().describe("issue: the places of the links url matches, filled in by FlockStack"),
	segment: z.string().max(24).optional().describe("snapshot: the ID of a saved list (a segment made by create_segment_snapshot)"),
	subject: z.string().optional().describe("issue: the issue's subject, filled in by FlockStack for the summary"),
	name: z.string().optional().describe("snapshot: the saved list's name, filled in by FlockStack for the summary"),
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

function readValues(condition, label) {
	const values = condition.values;
	if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) return { problem: `${label}: values is a list of 1 to ${MAX_VALUES}` };
	return { values };
}

// is, is_not, is_any_of and is_none_of over text values: status, source and country share them.
function checkChoice(condition, { label, normalize, hint }) {
	const op = condition.op ?? "is";
	if (!["is", "is_not", ...SET_OPS].includes(op)) return problem(`${label}: op is is, is_not, is_any_of or is_none_of`);
	if (SET_OPS.includes(op)) {
		const { values, problem: bad } = readValues(condition, label);
		if (bad) return problem(bad);
		const checked = values.map((value) => normalize(value));
		if (checked.some((value) => !value)) return problem(`${label}: ${hint}`);
		return { condition: { type: condition.type, op, values: [...new Set(checked)] } };
	}
	const value = normalize(condition.value);
	if (!value) return problem(`${label}: value ${hint}`);
	return { condition: { type: condition.type, op, value } };
}

const normalizeStatus = (value) => (CONTACT_STATUS_VALUES.includes(value) ? value : null);
const normalizeSource = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const normalizeCountry = (value) => (typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null);

// fieldTypes: custom field key to its type, or to the field ({ type, options, multiple }). Returns { condition } with the
// value in its stored form, or { problem }.
export function checkCondition(condition, fieldTypes) {
	switch (condition.type) {
		case "status":
			return checkChoice(condition, { label: "status", normalize: normalizeStatus, hint: `is one of ${CONTACT_STATUS_VALUES.join(", ")}` });
		case "tag": {
			const op = condition.op ?? "has";
			if (!["has", "has_not", ...SET_OPS].includes(op)) return problem("tag: op is has, has_not, is_any_of or is_none_of");
			if (SET_OPS.includes(op)) {
				const { values, problem: bad } = readValues(condition, "tag");
				if (bad) return problem(bad);
				const tags = values.map((value) => normalizeTag(value));
				if (tags.some((tag) => !tag)) return problem("tag: values are tags, e.g. vip");
				return { condition: { type: "tag", op, values: [...new Set(tags)] } };
			}
			const value = normalizeTag(condition.value);
			if (!value) return problem("tag: value is a tag, e.g. vip");
			return { condition: { type: "tag", op, value } };
		}
		case "source":
			return checkChoice(condition, { label: "source", normalize: normalizeSource, hint: "is where they signed up, e.g. website" });
		case "country":
			return checkChoice(condition, { label: "country", normalize: normalizeCountry, hint: "is a two-letter country code, e.g. US" });
		case "tier": {
			const op = condition.op ?? "is";
			if (!["is", "is_not"].includes(op)) return problem("tier: op is is or is_not");
			if (!CONTACT_TIER_VALUES.includes(condition.value)) return problem(`tier: value is one of ${CONTACT_TIER_VALUES.join(", ")}`);
			return { condition: { type: "tier", op, value: condition.value } };
		}
		case "referrals": {
			const op = condition.op ?? "gte";
			if (!["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) return problem("referrals: op is eq, neq, gt, gte, lt or lte");
			const value = typeof condition.value === "number" ? condition.value : Number.NaN;
			if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return problem("referrals: value is a number of referrals, 0 or more");
			if (op === "lt" && value === 0) return problem("referrals: nobody has fewer than 0 referrals");
			return { condition: { type: "referrals", op, value } };
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
			if (SET_OPS.includes(condition.op)) {
				const { values, problem: bad } = readValues(condition, "field");
				if (bad) return problem(bad);
				const parsedValues = [];
				for (const value of values) {
					const parsed = parseFieldValue(type, value, { ...definition, multiple: false });
					if (parsed.problem || parsed.value === null) return problem(`field ${condition.field}: values ${parsed.problem ?? "are needed"}`);
					parsedValues.push(parsed.value);
				}
				return { condition: { type: "field", field: condition.field, op: condition.op, values: [...new Set(parsedValues)] } };
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
		case "poll": {
			const op = condition.op ?? "is";
			if (!POLL_OPS.includes(op)) return problem(`poll: op is one of ${POLL_OPS.join(", ")}`);
			if (!/^[a-f0-9]{24}$/i.test(condition.poll ?? "")) return problem("poll: poll is the poll's ID");
			const poll = condition.poll.toLowerCase();
			if (["is_set", "is_not_set"].includes(op)) return { condition: { type: "poll", poll, op } };
			if (SET_OPS.includes(op)) {
				if (!Array.isArray(condition.options) || condition.options.length === 0 || !condition.options.every(Number.isInteger)) return problem("poll: options are the answers, 0 for the first");
				return { condition: { type: "poll", poll, op, options: [...new Set(condition.options)].sort((a, b) => a - b) } };
			}
			if (!Number.isInteger(condition.option)) return problem("poll: option is the answer, 0 for the first");
			return { condition: { type: "poll", poll, op, option: condition.option } };
		}
		case "issue": {
			if (!/^[a-f0-9]{24}$/i.test(condition.campaign ?? "")) return problem("issue: campaign is the issue's ID");
			if (!ISSUE_ACTIONS.includes(condition.action)) return problem(`issue: action is one of ${ISSUE_ACTIONS.join(", ")}`);
			const isClick = condition.action.includes("clicked");
			if ((condition.link !== undefined || condition.url) && !isClick) return problem("issue: link and url go with clicked and not_clicked");
			if (condition.link !== undefined && condition.url) return problem("issue: give link or url, not both");
			return {
				condition: {
					type: "issue",
					campaign: condition.campaign.toLowerCase(),
					action: condition.action,
					...(condition.link !== undefined && { link: condition.link }),
					...(condition.url?.trim() && { url: condition.url.trim() }),
				},
			};
		}
		case "snapshot":
			if (!/^[a-f0-9]{24}$/i.test(condition.segment ?? "")) return problem("snapshot: segment is a saved list's ID");
			return { condition: { type: "snapshot", segment: condition.segment.toLowerCase() } };
		default:
			return problem(`type is one of ${CONDITION_TYPES.join(", ")}`);
	}
}

// Rules as the schema parsed them -> rules ready to store, or { problem }. Every value is in its stored form after this,
// so compiling needs nothing but the rules.
export function checkRules(rules, fieldTypes) {
	const total = rules.conditions.reduce((sum, item) => sum + (isGroup(item) ? item.conditions.length : 1), 0);
	if (total > MAX_TOTAL_CONDITIONS) return problem(`rules have up to ${MAX_TOTAL_CONDITIONS} conditions, groups included`);
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
	const checkedRules = { match: rules.match, conditions: checked };
	if (collectLookups(checkedRules).length > MAX_LOOKUP_CONDITIONS) return problem(`rules have up to ${MAX_LOOKUP_CONDITIONS} conditions on an issue or a saved list`);
	return { rules: checkedRules };
}

// ---- Conditions that need contacts looked up first

export function needsLookup(condition) {
	return condition.type === "issue" || condition.type === "snapshot";
}

function getIssueLinks(condition) {
	if (condition.links?.length > 0) return condition.links;
	return Number.isInteger(condition.link) ? [condition.link] : null;
}

export function lookupKey(condition) {
	if (condition.type === "snapshot") return `snapshot:${condition.segment}`;
	return `issue:${condition.campaign}:${condition.action}:${(getIssueLinks(condition) ?? []).join(",")}`;
}

export { getIssueLinks };

// The conditions of the rules that lib/segments.js has to look up, once each.
export function collectLookups(rules) {
	const found = new Map();
	for (const item of rules.conditions) {
		for (const condition of isGroup(item) ? item.conditions : [item]) {
			if (needsLookup(condition)) found.set(lookupKey(condition), condition);
		}
	}
	return [...found].map(([key, condition]) => ({ key, condition }));
}

// Contacts by ID, in chunks that each fit a bound parameter.
function compileIds(ids) {
	if (ids.length === 0) return { _id: { $in: [] } };
	const chunks = [];
	for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) chunks.push(ids.slice(start, start + LOOKUP_CHUNK));
	return chunks.length === 1 ? { _id: { $in: chunks[0] } } : { $or: chunks.map((chunk) => ({ _id: { $in: chunk } })) };
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
function compileField({ field, op, value, values }) {
	const path = `fields.${field}`;
	switch (op) {
		case "is_any_of":
			return { [path]: { $in: values } };
		case "is_none_of":
			return { [path]: { $nin: values } };
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

// A choice: is, is_not, is_any_of, is_none_of on one path.
function compileChoice(path, condition) {
	switch (condition.op) {
		case "is_not":
			return { [path]: { $ne: condition.value } };
		case "is_any_of":
			return { [path]: { $in: condition.values } };
		case "is_none_of":
			return { [path]: { $nin: condition.values } };
		default:
			return { [path]: condition.value };
	}
}

// Referrals a contact has: a contact nobody credited has no count, which is 0.
function compileReferrals({ op, value }) {
	const path = "referral.count";
	const orNone = (match) => ({ $or: [{ [path]: match }, { [path]: null }] });
	switch (op) {
		case "eq":
			return value === 0 ? orNone(0) : { [path]: value };
		case "neq":
			return value === 0 ? { [path]: { $gt: 0 } } : { [path]: { $ne: value } };
		case "gt":
			return { [path]: { $gt: value } };
		case "gte":
			return value === 0 ? orNone({ $gte: 0 }) : { [path]: { $gte: value } };
		case "lt":
			return orNone({ $lt: value });
		default:
			return orNone({ $lte: value });
	}
}

export function compileCondition(condition, now = new Date(), lookups = null) {
	switch (condition.type) {
		case "status":
			return compileChoice("status", condition);
		case "tag":
			if (condition.op === "is_any_of") return { tags: { $in: condition.values } };
			if (condition.op === "is_none_of") return { tags: { $nin: condition.values } };
			return { tags: condition.op === "has_not" ? { $ne: condition.value } : condition.value };
		case "source":
			return compileChoice("source", condition);
		case "country":
			return compileChoice("country", condition);
		case "tier":
			return condition.op === "is_not"
				? audienceTierFilter(condition.value === "paid" ? "free" : "paid", now.getTime())
				: audienceTierFilter(condition.value, now.getTime());
		case "referrals":
			return compileReferrals(condition);
		case "issue":
		case "snapshot": {
			const ids = lookups?.get(lookupKey(condition));
			if (!ids) throw new Error(`The ${condition.type} condition needs its contacts looked up first (lib/segments.js loadLookups)`);
			return compileIds(ids);
		}
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
		case "poll": {
			// lib/polls.js keeps each subscriber's answer here.
			const path = `polls.p${condition.poll}`;
			if (condition.op === "is_set" || condition.op === "is_not_set") return { [path]: { $exists: condition.op === "is_set" } };
			if (condition.op === "is_any_of") return { [path]: { $in: condition.options } };
			if (condition.op === "is_none_of") return { [path]: { $nin: condition.options } };
			return { [path]: condition.op === "is_not" ? { $ne: condition.option } : condition.option };
		}
		default:
			return { importId: { $exists: condition.value !== false } };
	}
}

// The filter for the contacts a segment matches, to put next to the account and newsletter. now: for "in the last N days".
export function compileRules(rules, now = new Date(), lookups = null) {
	const parts = rules.conditions.map((item) =>
		isGroup(item)
			? { [item.match === "any" ? "$or" : "$and"]: item.conditions.map((condition) => compileCondition(condition, now, lookups)) }
			: compileCondition(item, now, lookups)
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

const SET_NAMES = { is_any_of: "is any of", is_none_of: "is none of" };
const TIER_NAMES = { free: "a free subscriber", paid: "a paid subscriber" };

function describeIssueAction(condition) {
	const issue = condition.subject ? `"${condition.subject}"` : "an issue";
	const link = condition.url ? `the link ${condition.url} in ` : condition.link !== undefined ? `link ${condition.link + 1} in ` : "";
	switch (condition.action) {
		case "opened":
			return `Opened ${issue}`;
		case "clicked":
			return `Clicked ${link || "a link in "}${issue}`;
		case "not_opened":
			return `Got ${issue} and didn't open it`;
		default:
			return `Got ${issue} and didn't click ${link || "a link in "}it`;
	}
}

// One condition in words, for lists and summaries.
export function describeCondition(condition) {
	switch (condition.type) {
		case "status":
		case "source":
		case "country": {
			const name = { status: "Status", source: "Source", country: "Country" }[condition.type];
			if (SET_NAMES[condition.op]) return `${name} ${SET_NAMES[condition.op]} ${condition.values.join(", ")}`;
			return `${name} ${STATUS_NAMES[condition.op]} ${condition.value}`;
		}
		case "tag":
			if (SET_NAMES[condition.op]) return `${condition.op === "is_any_of" ? "Has any of" : "Has none of"} the tags ${condition.values.join(", ")}`;
			return `${condition.op === "has_not" ? "Doesn't have" : "Has"} the tag ${condition.value}`;
		case "tier":
			return `${condition.op === "is_not" ? "Isn't" : "Is"} ${TIER_NAMES[condition.value]}`;
		case "referrals":
			return `Referrals ${OP_NAMES[condition.op]} ${condition.value}`;
		case "field":
			if (SET_NAMES[condition.op]) return `${condition.field} ${SET_NAMES[condition.op]} ${condition.values.join(", ")}`;
			return `${condition.field} ${OP_NAMES[condition.op]}${condition.value === undefined ? "" : ` ${condition.value}`}`;
		case "signup_date":
			return `Signed up ${condition.from ? `from ${condition.from} ` : ""}${condition.to ? `to ${condition.to}` : ""}`.trim();
		case "engagement":
			return ENGAGEMENT_NAMES[condition.kind](condition.days);
		case "poll": {
			const poll = condition.question ? `the poll "${condition.question}"` : "a poll";
			if (condition.op === "is_set") return `Voted in ${poll}`;
			if (condition.op === "is_not_set") return `Didn't vote in ${poll}`;
			if (SET_NAMES[condition.op]) {
				const answers = (condition.answers ? condition.answers.map((answer) => `"${answer}"`) : condition.options.map((option) => `answer ${option + 1}`)).join(", ");
				return `${condition.op === "is_any_of" ? "Answered any of" : "Answered none of"} ${answers} in ${poll}`;
			}
			const answer = condition.answer ? `"${condition.answer}"` : `answer ${condition.option + 1}`;
			return `${condition.op === "is_not" ? "Didn't answer" : "Answered"} ${answer} in ${poll}`;
		}
		case "issue":
			return describeIssueAction(condition);
		case "snapshot":
			return `On the saved list ${condition.name ?? "a saved list"}`;
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
