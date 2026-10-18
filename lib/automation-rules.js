import * as z from "zod";
import { normalizeTag } from "./tag-rules.js";
import { MAX_BODY_BYTES } from "./validation.js";

// The shape of an automation: what starts it (a trigger) and what happens next (steps). Nothing here touches the
// database; lib/automations.js checks them against the newsletter and runs them.

export const TRIGGER_TYPES = ["subscribed", "tag_added", "segment_joined", "date_field"];
export const STEP_TYPES = ["email", "wait", "add_tag", "remove_tag", "end"];
export const WAIT_UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const STEP_FORMATS = ["markdown", "rich", "html"];
export const MAX_STEPS = 20;
export const MAX_WAIT_MS = 365 * WAIT_UNITS.days;
// Scheduled triggers are looked at this often (a date trigger once a day).
export const SEGMENT_EVALUATION_MINUTES = 60;

export const TriggerSchema = z.object({
	type: z.enum(TRIGGER_TYPES).describe("subscribed: a contact joins (confirmed, if the newsletter asks for it). tag_added: a contact gets the tag. segment_joined: a contact starts matching the segment, checked about every hour. date_field: the day of a contact's date field, plus offsetDays."),
	tag: z.string().max(60).optional().describe("tag_added: the tag. subscribed: only contacts who signed up with this tag."),
	source: z.string().max(100).optional().describe("subscribed: only contacts with this source, e.g. website or api"),
	segment: z.string().max(100).optional().describe("segment_joined: the segment's ID or name"),
	field: z.string().max(30).optional().describe("date_field: the key of a date custom field"),
	offsetDays: z.number().int().min(-365).max(365).optional().describe("date_field: days after the date it starts, negative for before. Default 0."),
	repeat: z.enum(["once", "yearly"]).optional().describe("date_field: once, or every year on that day (birthdays, anniversaries). Default once."),
	includeExisting: z.boolean().optional().describe("segment_joined: also start for the contacts already in the segment when it's activated. Default false: only the ones who join after."),
});

export const StepSchema = z.object({
	id: z.string().max(40).optional().describe("A step's ID. Send the IDs you got back so contacts waiting on a step stay on it when the steps change."),
	type: z.enum(STEP_TYPES).describe("email: send an email. wait: wait. add_tag, remove_tag: change the contact's tags. end: the contact is done."),
	subject: z.string().trim().max(200).optional().describe("email: the subject line, 200 characters at most"),
	previewText: z.string().trim().max(300).optional().describe("email: the text inbox apps show after the subject"),
	format: z.enum(STEP_FORMATS).optional().describe("email: the format of content: markdown (the default), rich (an HTML fragment, what the dashboard editor writes) or html (a complete email)"),
	content: z.string().max(MAX_BODY_BYTES).optional().describe("email: the body in that format, 500 KB at most. Merge tags like {{first_name|there}} are filled in per contact."),
	amount: z.number().int().min(1).max(525_600).optional().describe("wait: how many units"),
	unit: z.enum(["minutes", "hours", "days"]).optional().describe("wait: minutes, hours or days"),
	tag: z.string().max(60).optional().describe("add_tag, remove_tag: the tag"),
});

export function newStepId() {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

export function getWaitMs(step) {
	return step.amount * (WAIT_UNITS[step.unit] ?? 0);
}

// Steps as a caller sent them -> steps ready to store (ids kept or made, content in its field), or { problem }.
// isComplete: every email has a subject and content, as activating needs.
export function checkSteps(input, { isComplete = false } = {}) {
	if (input.length > MAX_STEPS) return { problem: `an automation has up to ${MAX_STEPS} steps` };
	const steps = [];
	const ids = new Set();
	for (const [index, step] of input.entries()) {
		const where = `steps[${index}]`;
		const id = step.id || newStepId();
		if (ids.has(id)) return { problem: `${where}: the id ${id} is used twice` };
		ids.add(id);
		if (step.type === "email") {
			const format = step.format ?? "markdown";
			const content = step.content ?? "";
			if (isComplete && !step.subject?.trim()) return { problem: `${where}: the email needs a subject` };
			if (isComplete && !content.trim()) return { problem: `${where}: the email needs content` };
			steps.push({
				id,
				type: "email",
				subject: step.subject?.trim() ?? "",
				previewText: step.previewText?.trim() ?? "",
				format,
				[format === "markdown" ? "markdown" : "html"]: content,
			});
		} else if (step.type === "wait") {
			if (!step.amount || !WAIT_UNITS[step.unit]) return { problem: `${where}: a wait needs amount and unit (minutes, hours or days)` };
			if (getWaitMs(step) > MAX_WAIT_MS) return { problem: `${where}: a wait is a year at most` };
			steps.push({ id, type: "wait", amount: step.amount, unit: step.unit });
		} else if (step.type === "add_tag" || step.type === "remove_tag") {
			const tag = normalizeTag(step.tag);
			if (!tag) return { problem: `${where}: ${step.type} needs a tag: letters, digits, spaces and - _ . : / + &` };
			steps.push({ id, type: step.type, tag });
		} else {
			steps.push({ id, type: "end" });
		}
	}
	return { steps };
}

// A stored step as the API shows it.
export function toStepOutput(step) {
	if (step.type === "email") {
		return {
			id: step.id,
			type: "email",
			subject: step.subject ?? "",
			previewText: step.previewText ?? "",
			format: step.format ?? "markdown",
			content: (step.format === "markdown" ? step.markdown : step.html) ?? "",
		};
	}
	if (step.type === "wait") return { id: step.id, type: "wait", amount: step.amount, unit: step.unit };
	if (step.type === "add_tag" || step.type === "remove_tag") return { id: step.id, type: step.type, tag: step.tag };
	return { id: step.id, type: "end" };
}

export function describeStep(step) {
	switch (step.type) {
		case "email":
			return `Send "${step.subject || "Untitled"}"`;
		case "wait":
			return `Wait ${step.amount} ${step.amount === 1 ? step.unit.slice(0, -1) : step.unit}`;
		case "add_tag":
			return `Add the tag ${step.tag}`;
		case "remove_tag":
			return `Remove the tag ${step.tag}`;
		default:
			return "End";
	}
}

export function describeTrigger(trigger, { segmentName } = {}) {
	switch (trigger.type) {
		case "subscribed":
			return `A contact subscribes${trigger.tag ? ` with the tag ${trigger.tag}` : ""}${trigger.source ? ` from ${trigger.source}` : ""}`;
		case "tag_added":
			return `A contact gets the tag ${trigger.tag}`;
		case "segment_joined":
			return `A contact joins ${segmentName ? `the segment ${segmentName}` : "a segment"}`;
		default: {
			const days = trigger.offsetDays ?? 0;
			const when = days === 0 ? "On" : `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days < 0 ? "before" : "after"}`;
			return `${when} the date in ${trigger.field}${trigger.repeat === "yearly" ? ", every year" : ""}`;
		}
	}
}
