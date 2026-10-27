import { markdownToHtml } from "./markdown.js";
import { rulesFromState, stateFromRules } from "./rules-state.js";

// What the automation editor holds while an automation is edited, and how it turns into the steps update_automation takes.
// Steps are a tree like the stored ones (lib/automation-rules.js); the editor gives each step and path a key of its own so
// React keeps them apart, and keeps the id the server gave a step so it stays the same when the steps are saved.

export const MAX_NESTING = 3;
export const MAX_SPLIT_PATHS = 5;
let nextKey = 0;

export function newKey() {
	return `k${nextKey++}`;
}

function toLocalInput(iso) {
	return iso ? String(iso).slice(0, 16) : "";
}

// A step as the API shows it -> as the editor holds it.
export function fromApiStep(step) {
	const base = { ...step, _key: newKey(), ...(step.variants?.length && { variants: step.variants.map((variant) => variant.content !== undefined && (variant.format ?? step.format) === "markdown" ? { ...variant, format: "rich", content: markdownToHtml(variant.content) } : { ...variant }) }) };
	switch (step.type) {
		case "email":
			// An email in Markdown is edited as rich text, and saved as such.
			return step.format === "markdown" ? { ...base, format: "rich", content: markdownToHtml(step.content ?? "") } : base;
		case "wait":
			if (step.until) return { ...base, waitMode: "until", until: toLocalInput(step.until) };
			if (step.weekday) return { ...base, waitMode: "weekday" };
			return { ...base, waitMode: "duration" };
		case "set_field":
			return { ...base, isClearing: step.value === null || step.value === undefined, value: step.value === null || step.value === undefined ? "" : step.value };
		case "branch": {
			const { condition, paths, ...rest } = base;
			return {
				...rest,
				mode: step.segment ? "segment" : "condition",
				segment: step.segment ?? "",
				rulesState: stateFromRules(condition),
				paths: paths.map((path) => ({ ...path, _key: newKey(), steps: path.steps.map(fromApiStep) })),
			};
		}
		case "split":
			return { ...base, paths: step.paths.map((path) => ({ ...path, _key: newKey(), steps: path.steps.map(fromApiStep) })) };
		default:
			return base;
	}
}

export function fromApiSteps(steps) {
	return steps.map(fromApiStep);
}

// A new step of a type, with what the editor needs to show it.
export function newStep(type) {
	const base = { _key: newKey(), type };
	switch (type) {
		case "email":
			return { ...base, subject: "", previewText: "", format: "rich", content: "" };
		case "wait":
			return { ...base, waitMode: "duration", amount: 1, unit: "days" };
		case "add_tag":
		case "remove_tag":
			return { ...base, tag: "" };
		case "set_field":
			return { ...base, field: "", value: "", isClearing: false };
		case "webhook":
			return { ...base, name: "" };
		case "branch":
			return {
				...base,
				mode: "condition",
				segment: "",
				rulesState: stateFromRules(null),
				paths: [
					{ _key: newKey(), steps: [] },
					{ _key: newKey(), steps: [] },
				],
			};
		case "split":
			return {
				...base,
				paths: [
					{ _key: newKey(), percent: 50, steps: [] },
					{ _key: newKey(), percent: 50, steps: [] },
				],
			};
		case "move":
			return { ...base, automation: "" };
		default:
			return base;
	}
}

function toFieldValue(step, fields) {
	if (step.isClearing) return null;
	const field = fields.find(({ key }) => key === step.field);
	if (field?.type === "number") return step.value === "" ? "" : Number(step.value);
	if (field?.type === "boolean") return step.value === true || step.value === "true";
	if (field?.type === "list" && field.multiple) return (Array.isArray(step.value) ? step.value : String(step.value).split(",")).map((item) => item.trim()).filter(Boolean);
	return step.value;
}

// A step as the editor holds it -> what update_automation takes. fields: the newsletter's custom fields.
export function toApiStep(step, fields = []) {
	const { _key, id } = step;
	const own = id ? { id } : {};
	switch (step.type) {
		case "email":
			return { ...own, type: "email", subject: step.subject ?? "", previewText: step.previewText ?? "", format: step.format, content: step.content ?? "", ...(step.variants?.length && { variants: step.variants.map((variant) => ({ ...variant })) }), ...(step.variantSeed && { variantSeed: step.variantSeed }), ...(step.winnerVariantId && { winnerVariantId: step.winnerVariantId }) };
		case "wait":
			if (step.waitMode === "until") return { ...own, type: "wait", until: step.until ? `${step.until}:00Z` : "" };
			if (step.waitMode === "weekday") return { ...own, type: "wait", weekday: step.weekday ?? "monday", time: step.time || "09:00", timeZone: step.timeZone || "UTC" };
			return { ...own, type: "wait", amount: step.amount, unit: step.unit };
		case "add_tag":
		case "remove_tag":
			return { ...own, type: step.type, tag: step.tag ?? "" };
		case "set_field":
			return { ...own, type: "set_field", field: step.field ?? "", value: toFieldValue(step, fields) };
		case "webhook":
			return { ...own, type: "webhook", ...(step.name?.trim() && { name: step.name.trim() }) };
		case "branch":
			return {
				...own,
				type: "branch",
				...(step.mode === "segment" ? { segment: step.segment } : { condition: rulesFromState(step.rulesState) }),
				paths: step.paths.map((path) => ({ ...(path.name?.trim() && { name: path.name.trim() }), steps: path.steps.map((child) => toApiStep(child, fields)) })),
			};
		case "split":
			return {
				...own,
				type: "split",
				...(step.seed?.trim() && { seed: step.seed.trim() }),
				paths: step.paths.map((path) => ({ ...(path.name?.trim() && { name: path.name.trim() }), percent: Number(path.percent), steps: path.steps.map((child) => toApiStep(child, fields)) })),
			};
		case "move":
			return { ...own, type: "move", automation: step.automation ?? "" };
		default:
			return { ...own, type: "end" };
	}
}

export function toApiSteps(steps, fields = []) {
	return steps.map((step) => toApiStep(step, fields));
}

// ---- Changing the tree without changing the old one

function mapSteps(steps, visit) {
	return steps.map((step) => {
		const changed = visit(step);
		const paths = changed.paths?.map((path) => ({ ...path, steps: mapSteps(path.steps, visit) }));
		return paths ? { ...changed, paths } : changed;
	});
}

export function updateStep(steps, key, changes) {
	return mapSteps(steps, (step) => (step._key === key ? { ...step, ...changes } : step));
}

export function updatePath(steps, stepKey, pathKey, changes) {
	return mapSteps(steps, (step) => (step._key === stepKey ? { ...step, paths: step.paths.map((path) => (path._key === pathKey ? { ...path, ...changes } : path)) } : step));
}

function withoutStep(steps, key) {
	return steps.filter((step) => step._key !== key).map((step) => (step.paths ? { ...step, paths: step.paths.map((path) => ({ ...path, steps: withoutStep(path.steps, key) })) } : step));
}

export function removeStep(steps, key) {
	return withoutStep(steps, key);
}

// Puts a step at the end of a list.
export function addStep(steps, list, step) {
	if (!list) return [...steps, step];
	return mapSteps(steps, (existing) =>
		existing._key === list.stepKey
			? { ...existing, paths: existing.paths.map((path) => (path._key === list.pathKey ? { ...path, steps: [...path.steps, step] } : path)) }
			: existing
	);
}

function findList(steps, key) {
	if (steps.some((step) => step._key === key)) return steps;
	for (const step of steps) {
		for (const path of step.paths ?? []) {
			const found = findList(path.steps, key);
			if (found) return found;
		}
	}
	return null;
}

const ENDING = ["branch", "split"];

// A branch or a split has to stay at the end of its list, so it moves nowhere, and nothing moves past it.
export function canMoveStep(steps, key, direction) {
	const list = findList(steps, key);
	if (!list) return false;
	const index = list.findIndex((step) => step._key === key);
	const target = list[index + direction];
	if (!target || ENDING.includes(list[index].type)) return false;
	return !ENDING.includes(target.type);
}

// Swaps a step with its neighbour in the same list, if it can move.
export function moveStep(steps, key, direction) {
	if (!canMoveStep(steps, key, direction)) return steps;
	const swap = (list) => {
		const index = list.findIndex((step) => step._key === key);
		if (index === -1) return list.map((step) => (step.paths ? { ...step, paths: step.paths.map((path) => ({ ...path, steps: swap(path.steps) })) } : step));
		const next = [...list];
		[next[index], next[index + direction]] = [next[index + direction], next[index]];
		return next;
	};
	return swap(steps);
}

// The shares of a split's paths when they are divided evenly, the first taking what is left over.
export function evenPercents(count) {
	const share = Math.floor(100 / count);
	return Array.from({ length: count }, (_, index) => (index === 0 ? 100 - share * (count - 1) : share));
}

// Whether a list ends with a branch or a split, which takes no step after it.
export function hasEndingStep(steps) {
	return steps.length > 0 && ENDING.includes(steps.at(-1).type);
}
