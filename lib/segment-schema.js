import * as z from "zod";
import { CONDITION_TYPES, CONTACT_STATUS_VALUES, CONTACT_TIER_VALUES, ENGAGEMENT_KINDS, FIELD_OPS, ISSUE_ACTIONS, MAX_CONDITIONS, MAX_VALUES, SET_OPS } from "./segment-rules.js";

// The shape of a segment's rules for the API and MCP (zod), apart from lib/segment-rules.js: the dashboard compiles and describes rules on
// almost every page, and only an action that takes rules needs the schema, which is 500 KB of zod to load.

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
			"status: a contact status. tag: the tag. source: where they signed up. country: a two-letter country code, e.g. US. tier: free, paid (any paid tier) or a paid tier's ID. referrals: how many referrals. field: what to compare to (a number for number fields, YYYY-MM-DD for dates, an ISO date and time for datetime fields, true or false, a list field's option). imported: true or false (default true)."
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
	name: z.string().max(60).optional().describe("tier: the paid tier's name, filled in by FlockStack for the summary"),
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
