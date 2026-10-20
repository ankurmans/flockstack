// What a rules builder (components/EditorRules.jsx) holds, and how it turns into the rules the actions take: { match, items },
// where an item is a condition or a group { match, conditions }. Kept apart from the component so the automation editor can
// build branches from it too.

export const SET_OPS = ["is_any_of", "is_none_of"];

export function newCondition() {
	return { type: "tag", op: "has", value: "" };
}

export function isGroup(item) {
	return Array.isArray(item.conditions);
}

// What the builder holds is what the action takes, minus the parts of a condition its type doesn't use.
function cleanCondition(condition) {
	const { type } = condition;
	const isSet = SET_OPS.includes(condition.op);
	if (isSet && ["status", "tag", "source", "country"].includes(type)) return { type, op: condition.op, values: condition.values ?? [] };
	if (type === "field") {
		if (isSet) return { type, field: condition.field, op: condition.op, values: condition.values ?? [] };
		return { type, field: condition.field, op: condition.op, ...(!["is_set", "is_not_set"].includes(condition.op) && { value: condition.value }) };
	}
	if (type === "signup_date") return { type, ...(condition.from && { from: condition.from }), ...(condition.to && { to: condition.to }) };
	if (type === "engagement") return { type, kind: condition.kind, ...(condition.kind !== "never_opened" && { days: Number(condition.days) || undefined }) };
	if (type === "imported") return { type, value: condition.value !== false };
	if (type === "poll") {
		if (isSet) return { type, poll: condition.poll, op: condition.op, options: condition.options ?? [] };
		return { type, poll: condition.poll, op: condition.op, ...(["is", "is_not"].includes(condition.op) && { option: Number(condition.option) }) };
	}
	if (type === "referrals") return { type, op: condition.op, value: Number(condition.value) };
	if (type === "issue") {
		const isClick = condition.action?.includes("clicked");
		return {
			type,
			campaign: condition.campaign,
			action: condition.action,
			...(isClick && condition.url && { url: condition.url }),
			...(isClick && !condition.url && Number.isInteger(condition.link) && { link: condition.link }),
		};
	}
	if (type === "snapshot") return { type, segment: condition.segment };
	return { type, op: condition.op, value: condition.value };
}

// What the builder holds -> the rules the actions take.
export function rulesFromState({ match, items }) {
	return {
		match,
		conditions: items.map((item) => (isGroup(item) ? { match: item.match, conditions: item.conditions.map(cleanCondition) } : cleanCondition(item))),
	};
}

// Rules as the API shows them -> what the builder holds. Rules with no condition start with one.
export function stateFromRules(rules) {
	return { match: rules?.match ?? "all", items: rules?.conditions?.length ? rules.conditions : [newCondition()] };
}
