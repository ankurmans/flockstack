import * as z from "zod";
import { MAX_CONDITIONS } from "./segment-rules.js";
import { SegmentRulesSchema } from "./segment-schema.js";
import { normalizeTag } from "./tag-rules.js";
import { shiftDateKey, startOfDateKey, toDateKey } from "./time-zone.js";
import { MAX_BODY_BYTES } from "./validation.js";

// The shape of an automation: what starts it (a trigger) and what happens next (steps). Nothing here touches the
// database; lib/automations.js checks them against the newsletter and runs them.
//
// Steps are a tree: a list of steps, and a branch or a split ends its list with paths that are lists of steps too. A
// contact's place is one step's ID, which stays the same when the steps around it are edited.

export const TRIGGER_TYPES = [
	"subscribed",
	"tag_added",
	"tag_removed",
	"segment_joined",
	"segment_left",
	"date_field",
	"field_changed",
	"upgraded",
	"downgraded",
	"product_bought",
	"referral_credited",
	"unengaged",
	"link_clicked",
	"manual",
	"api",
];
export const STEP_TYPES = ["email", "wait", "add_tag", "remove_tag", "set_field", "webhook", "branch", "split", "move", "end"];
export const WAIT_UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const STEP_FORMATS = ["markdown", "rich", "html"];
// Steps in one list, and in the whole tree.
export const MAX_STEPS = 20;
export const MAX_TOTAL_STEPS = 60;
// Lists inside each other: the main list, the paths of a branch in it, and the paths of a branch in those.
export const MAX_NESTING = 3;
export const MIN_SPLIT_PATHS = 2;
export const MAX_SPLIT_PATHS = 5;
export const MAX_WAIT_MS = 365 * WAIT_UNITS.days;
export const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
// Scheduled triggers are looked at this often (a date trigger once a day).
export const SEGMENT_EVALUATION_MINUTES = 60;
// Triggers that look at the whole list from time to time instead of hearing of an event.
export const SCHEDULED_TRIGGERS = ["segment_joined", "segment_left", "date_field", "unengaged"];

export const TriggerSchema = z.object({
	type: z
		.enum(TRIGGER_TYPES)
		.describe(
			"subscribed: a contact joins (confirmed, if the newsletter asks for it). tag_added, tag_removed: a contact gets or loses the tag. segment_joined, segment_left: a contact starts or stops matching the segment, checked about every hour. date_field: the day of a contact's date field, plus offsetDays. field_changed: a contact's custom field gets a new value. upgraded, downgraded: a reader starts or stops paying for the paid tier. product_bought: a reader of the newsletter buys a product. referral_credited: a subscriber's referral is credited. unengaged: a contact has had no opens or clicks for days days, checked daily. link_clicked: a contact clicks a link in an issue. manual: you add contacts from the dashboard. api: your code adds contacts with enroll_contacts."
		),
	tag: z.string().max(60).optional().describe("tag_added, tag_removed: the tag. subscribed: only contacts who signed up with this tag."),
	source: z.string().max(100).optional().describe("subscribed: only contacts with this source, e.g. website or api"),
	segment: z.string().max(100).optional().describe("segment_joined, segment_left: the segment's ID or name"),
	field: z.string().max(30).optional().describe("date_field: the key of a date custom field. field_changed: the key of the custom field."),
	offsetDays: z.number().int().min(-365).max(365).optional().describe("date_field: days after the date it starts, negative for before. Default 0."),
	repeat: z.enum(["once", "yearly"]).optional().describe("date_field: once, or every year on that day (birthdays, anniversaries). Default once."),
	includeExisting: z.boolean().optional().describe("segment_joined: also start for the contacts already in the segment when it's activated. Default false: only the ones who join after."),
	product: z.string().max(24).optional().describe("product_bought: only this product's ID. Default: any product of the newsletter."),
	referrals: z.number().int().min(1).max(100_000).optional().describe("referral_credited: only when the referrer reaches this many credited referrals. Default: every credit."),
	days: z.number().int().min(1).max(3650).optional().describe("unengaged: how many days without an open or a click"),
	url: z.string().max(2000).optional().describe("link_clicked: the link's address, as it is in the issue"),
	campaign: z.string().max(24).optional().describe("link_clicked: only links in this issue (campaign ID). Default: that link in any issue."),
});

const StepValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(60)).max(20), z.null()]);

// A branch's rules in a path: the same shape, but its conditions aren't described again at every level (lib/segment-rules.js
// checks every field of them whatever the schema says).
const NestedRulesSchema = z.object({
	match: z.enum(["all", "any"]),
	conditions: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_CONDITIONS),
});

// A step as a caller sends it. paths nest to the depth the editor can show, written out because the OpenAPI document and
// the MCP tools can't point to a schema that contains itself. Only the first level carries the descriptions: the paths'
// steps take the same fields, and every copy of them is read by every agent that lists the tools.
function makeStepSchema(depth, isNested = false) {
	const about = (schema, text) => (isNested ? schema : schema.describe(text));
	const shape = {
		id: about(z.string().max(40).optional(), "A step's ID. Send the IDs you got back so contacts waiting on a step stay on it when the steps change. Letters, digits, - and _."),
		type: about(
			z.enum(STEP_TYPES),
			"email: send an email. wait: wait. add_tag, remove_tag: change the contact's tags. set_field: set a custom field. webhook: send an automation.step event to your webhook endpoints. branch: two paths, by whether the contact matches a condition. split: 2 to 5 paths by percent, chosen at random per contact. move: move the contact to another automation. end: the contact is done. A branch or a split ends its list: what follows goes inside its paths."
		),
		subject: about(z.string().trim().max(200).optional(), "email: the subject line, 200 characters at most"),
		previewText: about(z.string().trim().max(300).optional(), "email: the text inbox apps show after the subject"),
		format: about(z.enum(STEP_FORMATS).optional(), "email: the format of content: markdown (the default), rich (an HTML fragment, what the dashboard editor writes) or html (a complete email)"),
		content: about(z.string().max(MAX_BODY_BYTES).optional(), "email: the body in that format, 500 KB at most. Merge tags like {{first_name|there}} are filled in per contact."),
		amount: about(z.number().int().min(1).max(525_600).optional(), "wait: how many units"),
		unit: about(z.enum(["minutes", "hours", "days"]).optional(), "wait: minutes, hours or days"),
		until: about(z.string().max(40).optional(), "wait: wait until this date and time instead, e.g. 2026-12-01T09:00:00Z. A time in the past doesn't wait."),
		weekday: about(z.enum(WEEKDAYS).optional(), "wait: wait until the next time it is this day of the week, at time in timeZone"),
		time: about(z.string().max(5).optional(), "wait with weekday: the time of day, HH:MM, 24 hours. Default 09:00."),
		timeZone: about(z.string().max(64).optional(), "wait with weekday: an IANA time zone, e.g. Europe/Paris. Default UTC."),
		tag: about(z.string().max(60).optional(), "add_tag, remove_tag: the tag"),
		field: about(z.string().max(30).optional(), "set_field: the key of the custom field"),
		value: about(StepValue.optional(), "set_field: the value, or null to clear the field. A number for a number field, YYYY-MM-DD for a date, true or false, a list field's option."),
		name: about(z.string().trim().max(60).optional(), "webhook: a name your endpoint can tell this step by; it's in the event's data"),
		condition: about((isNested ? NestedRulesSchema : SegmentRulesSchema).optional(), "branch: the rules a contact is checked against, like a segment's. Send condition or segment."),
		segment: about(z.string().max(100).optional(), "branch: a saved segment's ID or name to check, instead of condition. It follows the segment's changes."),
		seed: about(z.string().max(60).optional(), "split: contacts are spread by a hash of this and the contact, so a contact takes the same path every time. Default: the step's ID. Use the same seed in two splits to keep the same contacts together."),
		automation: about(z.string().max(24).optional(), "move: the ID of the automation to move the contact to, in the same newsletter"),
	};
	if (depth > 0) {
		const path = {
			name: about(z.string().trim().max(60).optional(), "The path's name, for the editor and the report"),
			percent: about(z.number().int().min(1).max(99).optional(), "split: the share of contacts that take this path. The paths' shares add up to 100; leave all out to divide evenly."),
			steps: about(z.array(makeStepSchema(depth - 1, true)).max(MAX_STEPS), "The steps of this path"),
		};
		shape.paths = about(z.array(z.object(path)).max(MAX_SPLIT_PATHS).optional(), "branch: two paths, the first for contacts who match, the second for those who don't. split: 2 to 5 paths.");
	}
	return z.object(shape);
}

export const StepSchema = makeStepSchema(MAX_NESTING - 1);

export function newStepId() {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

export function getWaitMs(step) {
	return step.amount * (WAIT_UNITS[step.unit] ?? 0);
}

function isTimeZone(value) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

function checkWait(step, where) {
	const forms = [step.amount !== undefined || step.unit !== undefined, step.until !== undefined, step.weekday !== undefined].filter(Boolean).length;
	if (forms !== 1) return { problem: `${where}: a wait needs amount and unit (minutes, hours or days), or until, or weekday` };
	if (step.until !== undefined) {
		const at = new Date(step.until);
		if (!Number.isFinite(at.getTime())) return { problem: `${where}: until is a date and time like 2026-12-01T09:00:00Z` };
		return { step: { type: "wait", until: at.toISOString() } };
	}
	if (step.weekday !== undefined) {
		const time = step.time ?? "09:00";
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { problem: `${where}: time is HH:MM, 24 hours` };
		const timeZone = step.timeZone ?? "UTC";
		if (!isTimeZone(timeZone)) return { problem: `${where}: timeZone is a time zone like Europe/Paris` };
		return { step: { type: "wait", weekday: step.weekday, time, timeZone } };
	}
	if (!step.amount || !WAIT_UNITS[step.unit]) return { problem: `${where}: a wait needs amount and unit (minutes, hours or days)` };
	if (getWaitMs(step) > MAX_WAIT_MS) return { problem: `${where}: a wait is a year at most` };
	return { step: { type: "wait", amount: step.amount, unit: step.unit } };
}

function checkPaths(step, where, level, state) {
	const isSplit = step.type === "split";
	if (level >= MAX_NESTING) return { problem: `${where}: paths nest ${MAX_NESTING} lists deep at most` };
	const paths = step.paths ?? (isSplit ? [{ steps: [] }, { steps: [] }] : [{ steps: [] }, { steps: [] }]);
	if (!isSplit && paths.length !== 2) return { problem: `${where}: a branch has two paths: the first for contacts who match, the second for the rest` };
	if (isSplit && (paths.length < MIN_SPLIT_PATHS || paths.length > MAX_SPLIT_PATHS)) return { problem: `${where}: a split has ${MIN_SPLIT_PATHS} to ${MAX_SPLIT_PATHS} paths` };
	let percents = paths.map((path) => path.percent);
	if (isSplit) {
		const given = percents.filter((percent) => percent !== undefined).length;
		if (given !== 0 && given !== paths.length) return { problem: `${where}: give every path a percent, or none to divide evenly` };
		if (given === 0) {
			const share = Math.floor(100 / paths.length);
			percents = paths.map((_, index) => (index === 0 ? 100 - share * (paths.length - 1) : share));
		} else if (percents.reduce((sum, percent) => sum + percent, 0) !== 100) return { problem: `${where}: the paths' percents add up to 100` };
	} else if (percents.some((percent) => percent !== undefined)) return { problem: `${where}: a branch's paths have no percent` };
	const stored = [];
	for (const [index, path] of paths.entries()) {
		const result = checkList(path.steps ?? [], `${where}.paths[${index}].steps`, level + 1, state);
		if (result.problem) return result;
		stored.push({ ...(path.name && { name: path.name }), ...(isSplit && { percent: percents[index] }), steps: result.steps });
	}
	return { paths: stored };
}

function checkList(input, prefix, level, state) {
	if (input.length > MAX_STEPS) return { problem: `${level === 1 ? "an automation's main list" : "a path"} has up to ${MAX_STEPS} steps` };
	const steps = [];
	for (const [index, step] of input.entries()) {
		const where = `${prefix}[${index}]`;
		if (step.id !== undefined && !STEP_ID_PATTERN.test(step.id)) return { problem: `${where}: an id is letters, digits, - and _, 40 at most` };
		const id = step.id || newStepId();
		if (state.ids.has(id)) return { problem: `${where}: the id ${id} is used twice` };
		state.ids.add(id);
		if (state.ids.size > MAX_TOTAL_STEPS) return { problem: `an automation has up to ${MAX_TOTAL_STEPS} steps in all, paths included` };
		if (["branch", "split"].includes(step.type) && index !== input.length - 1) {
			return { problem: `${where}: a ${step.type} ends its list: put the steps that follow it inside its paths` };
		}
		if (step.type === "email") {
			const format = step.format ?? "markdown";
			const content = step.content ?? "";
			if (state.isComplete && !step.subject?.trim()) return { problem: `${where}: the email needs a subject` };
			if (state.isComplete && !content.trim()) return { problem: `${where}: the email needs content` };
			steps.push({
				id,
				type: "email",
				subject: step.subject?.trim() ?? "",
				previewText: step.previewText?.trim() ?? "",
				format,
				[format === "markdown" ? "markdown" : "html"]: content,
			});
		} else if (step.type === "wait") {
			const result = checkWait(step, where);
			if (result.problem) return result;
			steps.push({ id, ...result.step });
		} else if (step.type === "add_tag" || step.type === "remove_tag") {
			const tag = normalizeTag(step.tag);
			if (!tag) return { problem: `${where}: ${step.type} needs a tag: letters, digits, spaces and - _ . : / + &` };
			steps.push({ id, type: step.type, tag });
		} else if (step.type === "set_field") {
			if (!step.field?.trim()) return { problem: `${where}: set_field needs the key of a custom field` };
			steps.push({ id, type: "set_field", field: step.field.trim().toLowerCase(), value: step.value ?? null });
		} else if (step.type === "webhook") {
			steps.push({ id, type: "webhook", ...(step.name && { name: step.name }) });
		} else if (step.type === "branch") {
			if (Boolean(step.condition) === Boolean(step.segment)) return { problem: `${where}: a branch needs condition or segment, not both` };
			const result = checkPaths(step, where, level, state);
			if (result.problem) return result;
			steps.push({ id, type: "branch", ...(step.condition ? { rules: step.condition } : { segment: step.segment }), paths: result.paths });
		} else if (step.type === "split") {
			const result = checkPaths(step, where, level, state);
			if (result.problem) return result;
			steps.push({ id, type: "split", ...(step.seed && { seed: step.seed }), paths: result.paths });
		} else if (step.type === "move") {
			if (!/^[a-f0-9]{24}$/i.test(step.automation ?? "")) return { problem: `${where}: move needs the ID of an automation` };
			steps.push({ id, type: "move", automation: step.automation.toLowerCase() });
		} else {
			steps.push({ id, type: "end" });
		}
	}
	return { steps };
}

// Steps as a caller sent them -> steps ready to store (ids kept or made, content in its field), or { problem }. What
// needs the database (a field, a segment, an automation) is checked by lib/automations.js afterwards.
// isComplete: every email has a subject and content, as activating needs.
export function checkSteps(input, { isComplete = false } = {}) {
	return checkList(input, "steps", 1, { ids: new Set(), isComplete });
}

// ---- Walking the tree

// Calls visit(step, { list, index, level, parentId, pathIndex }) for every step, a path's steps after the step that owns it.
export function walkSteps(steps, visit, context = { level: 1, parentId: null, pathIndex: null }) {
	for (const [index, step] of (steps ?? []).entries()) {
		visit(step, { list: steps, index, level: context.level, parentId: context.parentId, pathIndex: context.pathIndex });
		for (const [pathIndex, path] of (step.paths ?? []).entries()) {
			walkSteps(path.steps, visit, { level: context.level + 1, parentId: step.id, pathIndex });
		}
	}
}

// Every step by ID with where it sits. Built once per run of the job for each automation.
export function indexSteps(steps) {
	const found = new Map();
	walkSteps(steps, (step, place) => found.set(step.id, { step, ...place }));
	return found;
}

export function countSteps(steps) {
	let count = 0;
	walkSteps(steps, () => count++);
	return count;
}

export function listSteps(steps) {
	const all = [];
	walkSteps(steps, (step, place) => all.push({ step, ...place }));
	return all;
}

// The step after this one in its list, or null when its path ends there.
export function nextStep(index, stepId) {
	const place = index.get(stepId);
	return place?.list[place.index + 1] ?? null;
}

export function findStepSegmentIds(steps) {
	const ids = [];
	walkSteps(steps, (step) => {
		if (step.type === "branch" && step.segmentId) ids.push(String(step.segmentId));
	});
	return ids;
}

// ---- Random splits

// A number from 0 up to but not including 1 for a string: the same string always gives the same number, and different
// strings are spread evenly (cyrb53).
export function hashToUnit(text) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 2 ** 53;
}

// Which path of a split a seed takes, by the paths' percents: the same seed always takes the same path.
export function pickSplitPath(percents, seed) {
	const point = hashToUnit(String(seed)) * 100;
	let from = 0;
	for (const [index, percent] of percents.entries()) {
		from += percent;
		if (point < from) return index;
	}
	return percents.length - 1;
}

export function getSplitSeed(step, contactId) {
	return `${step.seed ?? step.id}:${contactId}`;
}

// ---- Waiting until

// When a wait that isn't a duration ends: the date and time, or the next time it is the weekday at that time of day.
export function getWaitUntil(step, now = new Date()) {
	if (step.until) return new Date(step.until);
	const timeZone = step.timeZone ?? "UTC";
	const [hours, minutes] = (step.time ?? "09:00").split(":").map(Number);
	const today = toDateKey(now, timeZone);
	const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
	const target = WEEKDAYS.indexOf(step.weekday);
	for (let ahead = 0; ahead <= 7; ahead++) {
		const key = shiftDateKey(today, ahead);
		if ((todayWeekday + ahead) % 7 !== target) continue;
		const at = new Date(startOfDateKey(key, timeZone).getTime() + (hours * 60 + minutes) * 60_000);
		if (at > now) return at;
	}
	return now;
}

export function isDurationWait(step) {
	return step.amount !== undefined;
}

// A stored step as the API shows it.
export function toStepOutput(step) {
	switch (step.type) {
		case "email":
			return {
				id: step.id,
				type: "email",
				subject: step.subject ?? "",
				previewText: step.previewText ?? "",
				format: step.format ?? "markdown",
				content: (step.format === "markdown" ? step.markdown : step.html) ?? "",
			};
		case "wait":
			if (step.until) return { id: step.id, type: "wait", until: step.until };
			if (step.weekday) return { id: step.id, type: "wait", weekday: step.weekday, time: step.time ?? "09:00", timeZone: step.timeZone ?? "UTC" };
			return { id: step.id, type: "wait", amount: step.amount, unit: step.unit };
		case "add_tag":
		case "remove_tag":
			return { id: step.id, type: step.type, tag: step.tag };
		case "set_field":
			return { id: step.id, type: "set_field", field: step.field, value: step.value ?? null };
		case "webhook":
			return { id: step.id, type: "webhook", ...(step.name && { name: step.name }) };
		case "branch":
			return {
				id: step.id,
				type: "branch",
				...(step.segmentId ? { segment: String(step.segmentId) } : step.segment ? { segment: step.segment } : { condition: step.rules }),
				paths: step.paths.map((path) => ({ ...(path.name && { name: path.name }), steps: path.steps.map(toStepOutput) })),
			};
		case "split":
			return {
				id: step.id,
				type: "split",
				...(step.seed && { seed: step.seed }),
				paths: step.paths.map((path) => ({ ...(path.name && { name: path.name }), percent: path.percent, steps: path.steps.map(toStepOutput) })),
			};
		case "move":
			return { id: step.id, type: "move", automation: step.automation };
		default:
			return { id: step.id, type: "end" };
	}
}

const WEEKDAY_NAMES = Object.fromEntries(WEEKDAYS.map((day) => [day, day[0].toUpperCase() + day.slice(1)]));

export function describeStep(step) {
	switch (step.type) {
		case "email":
			return `Send "${step.subject || "Untitled"}"`;
		case "wait":
			if (step.until) return `Wait until ${step.until.slice(0, 16).replace("T", " ")} UTC`;
			if (step.weekday) return `Wait until ${WEEKDAY_NAMES[step.weekday]} at ${step.time ?? "09:00"}${step.timeZone && step.timeZone !== "UTC" ? ` (${step.timeZone})` : " UTC"}`;
			return `Wait ${step.amount} ${step.amount === 1 ? step.unit.slice(0, -1) : step.unit}`;
		case "add_tag":
			return `Add the tag ${step.tag}`;
		case "remove_tag":
			return `Remove the tag ${step.tag}`;
		case "set_field":
			return step.value === null || step.value === undefined ? `Clear ${step.field}` : `Set ${step.field} to ${Array.isArray(step.value) ? step.value.join(", ") : step.value}`;
		case "webhook":
			return step.name ? `Send the webhook ${step.name}` : "Send a webhook";
		case "branch":
			return "Branch: matches or not";
		case "split":
			return `Split ${step.paths.map((path) => `${path.percent}%`).join(" / ")}`;
		case "move":
			return "Move to another automation";
		default:
			return "End";
	}
}

export function describeTrigger(trigger, { segmentName, productTitle } = {}) {
	switch (trigger.type) {
		case "subscribed":
			return `A contact subscribes${trigger.tag ? ` with the tag ${trigger.tag}` : ""}${trigger.source ? ` from ${trigger.source}` : ""}`;
		case "tag_added":
			return `A contact gets the tag ${trigger.tag}`;
		case "tag_removed":
			return `A contact loses the tag ${trigger.tag}`;
		case "segment_joined":
			return `A contact joins ${segmentName ? `the segment ${segmentName}` : "a segment"}`;
		case "segment_left":
			return `A contact leaves ${segmentName ? `the segment ${segmentName}` : "a segment"}`;
		case "field_changed":
			return `A contact's ${trigger.field} changes`;
		case "upgraded":
			return "A reader upgrades to paid";
		case "downgraded":
			return "A reader drops to free";
		case "product_bought":
			return `A reader buys ${productTitle ?? "a product"}`;
		case "referral_credited":
			return trigger.referrals ? `A subscriber reaches ${trigger.referrals} referrals` : "A subscriber's referral is credited";
		case "unengaged":
			return `A contact has no opens or clicks for ${trigger.days} days`;
		case "link_clicked":
			return `A contact clicks ${trigger.url}`;
		case "manual":
			return "You add a contact by hand";
		case "api":
			return "Your code adds a contact";
		default: {
			const days = trigger.offsetDays ?? 0;
			const when = days === 0 ? "On" : `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days < 0 ? "before" : "after"}`;
			return `${when} the date in ${trigger.field}${trigger.repeat === "yearly" ? ", every year" : ""}`;
		}
	}
}
