"use client";

import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SET_OPS, isGroup, newCondition } from "@/lib/rules-state";

const STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];
const TYPE_LABELS = {
	status: "Status",
	tag: "Tag",
	tier: "Free or paid",
	field: "Custom field",
	signup_date: "Signup date",
	source: "Source",
	country: "Country",
	referrals: "Referrals",
	engagement: "Engagement",
	issue: "An issue",
	imported: "Imported",
	poll: "Poll answer",
	snapshot: "Saved list",
};
const CHOICE_OPS = [
	["is", "is"],
	["is_not", "is not"],
	["is_any_of", "is any of"],
	["is_none_of", "is none of"],
];
const TAG_OPS = [
	["has", "has"],
	["has_not", "doesn't have"],
	["is_any_of", "has any of"],
	["is_none_of", "has none of"],
];
const REFERRAL_OPS = [
	["gte", "at least"],
	["lte", "at most"],
	["eq", "exactly"],
	["neq", "not"],
	["gt", "more than"],
	["lt", "fewer than"],
];
const ISSUE_ACTIONS = [
	["opened", "Opened"],
	["clicked", "Clicked"],
	["not_opened", "Got it, didn't open it"],
	["not_clicked", "Got it, didn't click"],
];
const POLL_OPS = [
	["is", "answered"],
	["is_not", "didn't answer"],
	["is_any_of", "answered any of"],
	["is_none_of", "answered none of"],
	["is_set", "voted"],
	["is_not_set", "didn't vote"],
];
const ENGAGEMENT_LABELS = {
	opened: "Opened in the last",
	clicked: "Clicked in the last",
	opened_or_clicked: "Opened or clicked in the last",
	never_opened: "Never opened an email",
	dormant: "No opens or clicks in the last",
};
const FIELD_OPS = {
	text: [
		["eq", "is"],
		["neq", "is not"],
		["contains", "contains"],
		["starts_with", "starts with"],
		["is_any_of", "is any of"],
		["is_none_of", "is none of"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	number: [
		["eq", "is"],
		["neq", "is not"],
		["gt", "is above"],
		["gte", "is at least"],
		["lt", "is below"],
		["lte", "is at most"],
		["is_any_of", "is any of"],
		["is_none_of", "is none of"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	date: [
		["eq", "is"],
		["gt", "is after"],
		["gte", "is on or after"],
		["lt", "is before"],
		["lte", "is on or before"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	datetime: [
		["gt", "is after"],
		["gte", "is at or after"],
		["lt", "is before"],
		["lte", "is at or before"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	boolean: [
		["eq", "is"],
		["neq", "is not"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	list: [
		["eq", "is"],
		["neq", "is not"],
		["is_any_of", "is any of"],
		["is_none_of", "is none of"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
	multiple: [
		["includes", "includes"],
		["excludes", "doesn't include"],
		["is_any_of", "includes any of"],
		["is_none_of", "includes none of"],
		["is_set", "has a value"],
		["is_not_set", "has no value"],
	],
};
// The rules builder of a segment and of an automation's branch: all or any of conditions and groups of conditions. The
// parent holds the state, which rulesFromState turns into what create_segment takes.
// fields, tags, polls, issues and lists are what lib/segment-choices.js loads for the newsletter.
export default function EditorRules({ state, onChange, fields, tags, polls = [], issues = [], lists = [] }) {
	function setItem(index, item) {
		onChange({ ...state, items: state.items.map((existing, position) => (position === index ? item : existing)) });
	}

	function removeItem(index) {
		onChange({ ...state, items: state.items.filter((_, position) => position !== index) });
	}

	const choices = { fields, tags, polls, issues, lists };

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				Contacts who match
				<MatchSelect value={state.match} onChange={(match) => onChange({ ...state, match })} />
				of these:
			</div>
			{state.items.map((item, index) =>
				isGroup(item) ? (
					<Group key={index} group={item} {...choices} onChange={(group) => setItem(index, group)} onRemove={() => removeItem(index)} />
				) : (
					<Condition key={index} condition={item} {...choices} onChange={(condition) => setItem(index, condition)} onRemove={() => removeItem(index)} />
				)
			)}
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onClick={() => onChange({ ...state, items: [...state.items, newCondition()] })}>
					<Plus data-icon="inline-start" />
					Condition
				</Button>
				<Button variant="outline" size="sm" onClick={() => onChange({ ...state, items: [...state.items, { match: "any", conditions: [newCondition()] }] })}>
					<Plus data-icon="inline-start" />
					Group
				</Button>
			</div>
		</div>
	);
}

function MatchSelect({ value, onChange }) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className="w-24" aria-label="Match">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">all</SelectItem>
				<SelectItem value="any">any</SelectItem>
			</SelectContent>
		</Select>
	);
}

function Group({ group, fields, tags, polls, issues, lists, onChange, onRemove }) {
	function setCondition(index, condition) {
		onChange({ ...group, conditions: group.conditions.map((existing, position) => (position === index ? condition : existing)) });
	}

	return (
		<div className="flex flex-col gap-2.5 rounded-xl bg-muted/40 p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				Group: match
				<MatchSelect value={group.match} onChange={(match) => onChange({ ...group, match })} />
				of
				<Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove the group" className="ml-auto text-muted-foreground hover:text-destructive">
					<Trash2 />
				</Button>
			</div>
			{group.conditions.map((condition, index) => (
				<Condition
					key={index}
					condition={condition}
					fields={fields}
					tags={tags}
					polls={polls}
					issues={issues}
					lists={lists}
					onChange={(next) => setCondition(index, next)}
					onRemove={group.conditions.length > 1 ? () => onChange({ ...group, conditions: group.conditions.filter((_, position) => position !== index) }) : null}
				/>
			))}
			<Button variant="outline" size="sm" className="self-start" onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition()] })}>
				<Plus data-icon="inline-start" />
				Condition
			</Button>
		</div>
	);
}

function defaultsFor(type, fields, polls = [], issues = [], lists = []) {
	switch (type) {
		case "status":
			return { type, op: "is", value: "active" };
		case "tag":
			return { type, op: "has", value: "" };
		case "source":
			return { type, op: "is", value: "" };
		case "field":
			return fieldCondition(fields[0]);
		case "signup_date":
			return { type, from: "", to: "" };
		case "engagement":
			return { type, kind: "opened", days: 30 };
		case "poll":
			return { type, poll: polls[0]?.id ?? "", op: "is", option: 0 };
		case "tier":
			return { type, op: "is", value: "paid" };
		case "country":
			return { type, op: "is", value: "" };
		case "referrals":
			return { type, op: "gte", value: 1 };
		case "issue":
			return { type, campaign: issues[0]?.id ?? "", action: "opened" };
		case "snapshot":
			return { type, segment: lists[0]?.id ?? "" };
		default:
			return { type, value: true };
	}
}

// A new condition on a field starts with the first op its type takes.
function fieldCondition(field) {
	const ops = FIELD_OPS[field?.multiple ? "multiple" : (field?.type ?? "text")];
	return { type: "field", field: field?.key ?? "", op: ops[0][0], value: "" };
}

function Condition({ condition, fields, tags, polls = [], issues = [], lists = [], onChange, onRemove }) {
	const listId = useId();
	const field = fields.find(({ key }) => key === condition.field);
	const poll = polls.find(({ id }) => id === condition.poll);
	const issue = issues.find(({ id }) => id === condition.campaign);
	const set = (changes) => onChange({ ...condition, ...changes });
	// Changing the comparison to or from a list of values starts the values over.
	const setOp = (op) => set({ op, ...(SET_OPS.includes(op) !== SET_OPS.includes(condition.op) && { values: [], options: [] }) });

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select value={condition.type} onValueChange={(type) => onChange(defaultsFor(type, fields, polls, issues, lists))}>
				<SelectTrigger size="sm" className="w-36" aria-label="Condition">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(TYPE_LABELS)
						.filter(
							([type]) =>
								(type !== "field" || fields.length > 0) &&
								(type !== "poll" || polls.length > 0) &&
								(type !== "issue" || issues.length > 0) &&
								(type !== "snapshot" || lists.length > 0)
						)
						.map(([type, label]) => (
							<SelectItem key={type} value={type}>
								{label}
							</SelectItem>
						))}
				</SelectContent>
			</Select>

			{condition.type === "status" && (
				<>
					<OpSelect value={condition.op} onChange={setOp} options={CHOICE_OPS} />
					{SET_OPS.includes(condition.op) ? (
						<ValuesInput key={condition.op} values={condition.values} onChange={(values) => set({ values })} placeholder="active, pending" label="Statuses" />
					) : (
						<Select value={condition.value} onValueChange={(value) => set({ value })}>
							<SelectTrigger size="sm" className="w-36" aria-label="Status">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{STATUSES.map((status) => (
									<SelectItem key={status} value={status}>
										{status}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</>
			)}

			{condition.type === "tag" && (
				<>
					<OpSelect value={condition.op} onChange={setOp} options={TAG_OPS} />
					{SET_OPS.includes(condition.op) ? (
						<ValuesInput key={condition.op} values={condition.values} onChange={(values) => set({ values })} placeholder="vip, beta" label="Tags" list={listId} />
					) : (
						<Input
							list={listId}
							value={condition.value}
							onChange={(event) => set({ value: event.target.value })}
							placeholder="Tag"
							aria-label="Tag"
							maxLength={60}
							className="h-8 w-40"
						/>
					)}
					<datalist id={listId}>
						{tags.map((tag) => (
							<option key={tag} value={tag} />
						))}
					</datalist>
				</>
			)}

			{condition.type === "source" && (
				<>
					<OpSelect value={condition.op} onChange={setOp} options={CHOICE_OPS} />
					{SET_OPS.includes(condition.op) ? (
						<ValuesInput key={condition.op} values={condition.values} onChange={(values) => set({ values })} placeholder="website, api" label="Sources" />
					) : (
						<Input value={condition.value} onChange={(event) => set({ value: event.target.value })} placeholder="e.g. website" aria-label="Source" maxLength={100} className="h-8 w-40" />
					)}
				</>
			)}

			{condition.type === "country" && (
				<>
					<OpSelect value={condition.op} onChange={setOp} options={CHOICE_OPS} />
					{SET_OPS.includes(condition.op) ? (
						<ValuesInput key={condition.op} values={condition.values} onChange={(values) => set({ values })} placeholder="US, DE, FR" label="Countries" />
					) : (
						<Input value={condition.value} onChange={(event) => set({ value: event.target.value })} placeholder="e.g. US" aria-label="Country" maxLength={2} className="h-8 w-24 uppercase" />
					)}
					<span className="text-xs text-muted-foreground">Two-letter codes. Known from signups since countries were kept.</span>
				</>
			)}

			{condition.type === "tier" && (
				<>
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={[["is", "is"], ["is_not", "is not"]]} />
					<Select value={condition.value} onValueChange={(value) => set({ value })}>
						<SelectTrigger size="sm" className="w-28" aria-label="Plan">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="paid">paid</SelectItem>
							<SelectItem value="free">free</SelectItem>
						</SelectContent>
					</Select>
				</>
			)}

			{condition.type === "referrals" && (
				<>
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={REFERRAL_OPS} />
					<Input type="number" min={0} value={condition.value ?? ""} onChange={(event) => set({ value: event.target.value })} aria-label="Referrals" className="h-8 w-24" />
					<span className="text-sm text-muted-foreground">credited referrals</span>
				</>
			)}

			{condition.type === "issue" && (
				<>
					<Select value={condition.action} onValueChange={(action) => set({ action, ...(!action.includes("clicked") && { link: undefined, url: undefined }) })}>
						<SelectTrigger size="sm" className="w-48" aria-label="What they did">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{ISSUE_ACTIONS.map(([action, label]) => (
								<SelectItem key={action} value={action}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={condition.campaign} onValueChange={(campaign) => set({ campaign, link: undefined, url: undefined })}>
						<SelectTrigger size="sm" className="w-56" aria-label="Issue">
							<SelectValue placeholder="Pick an issue" />
						</SelectTrigger>
						<SelectContent>
							{issues.map(({ id, subject }) => (
								<SelectItem key={id} value={id}>
									{subject || "No subject"}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{condition.action?.includes("clicked") && issue && issue.links.length > 0 && (
						<Select
							value={condition.url ? `url:${condition.url}` : Number.isInteger(condition.link) ? `link:${condition.link}` : "any"}
							onValueChange={(choice) => set(choice === "any" ? { link: undefined, url: undefined } : { link: Number(choice.slice(5)), url: undefined })}
						>
							<SelectTrigger size="sm" className="w-56" aria-label="Link">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="any">Any link</SelectItem>
								{condition.url && <SelectItem value={`url:${condition.url}`}>{condition.url}</SelectItem>}
								{issue.links.map(({ index, url }) => (
									<SelectItem key={index} value={`link:${index}`}>
										{index + 1}. {url}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</>
			)}

			{condition.type === "snapshot" && (
				<Select value={condition.segment} onValueChange={(segment) => set({ segment })}>
					<SelectTrigger size="sm" className="w-56" aria-label="Saved list">
						<SelectValue placeholder="Pick a saved list" />
					</SelectTrigger>
					<SelectContent>
						{lists.map(({ id, name }) => (
							<SelectItem key={id} value={id}>
								{name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			{condition.type === "field" && (
				<>
					<Select value={condition.field} onValueChange={(key) => onChange(fieldCondition(fields.find((item) => item.key === key)))}>
						<SelectTrigger size="sm" className="w-36" aria-label="Field">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{fields.map(({ key, label }) => (
								<SelectItem key={key} value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<OpSelect value={condition.op} onChange={setOp} options={FIELD_OPS[field?.multiple ? "multiple" : (field?.type ?? "text")]} />
					{SET_OPS.includes(condition.op) && (
						<ValuesInput
							key={`${condition.field}:${condition.op}`}
							values={condition.values}
							onChange={(values) => set({ values })}
							placeholder={field?.type === "list" ? field.options.join(", ") : "one, two"}
							label="Values"
						/>
					)}
					{!SET_OPS.includes(condition.op) && !["is_set", "is_not_set"].includes(condition.op) && (field?.type === "boolean" || field?.type === "list") && (
						<Select value={String(condition.value ?? "")} onValueChange={(value) => set({ value: field.type === "boolean" ? value === "true" : value })}>
							<SelectTrigger size="sm" className="w-40" aria-label="Value">
								<SelectValue placeholder="Pick one" />
							</SelectTrigger>
							<SelectContent>
								{(field.type === "boolean" ? ["true", "false"] : field.options).map((option) => (
									<SelectItem key={option} value={option}>
										{option}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					{!SET_OPS.includes(condition.op) && !["is_set", "is_not_set"].includes(condition.op) && field?.type !== "boolean" && field?.type !== "list" && (
						<Input
							type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : field?.type === "datetime" ? "datetime-local" : "text"}
							step={field?.type === "number" ? "any" : undefined}
							value={field?.type === "datetime" ? String(condition.value ?? "").slice(0, 16) : (condition.value ?? "")}
							onChange={(event) => set({ value: event.target.value })}
							aria-label="Value"
							className="h-8 w-40"
						/>
					)}
				</>
			)}

			{condition.type === "signup_date" && (
				<>
					<span className="text-sm text-muted-foreground">from</span>
					<Input type="date" value={condition.from ?? ""} onChange={(event) => set({ from: event.target.value })} aria-label="From" className="h-8 w-40" />
					<span className="text-sm text-muted-foreground">to</span>
					<Input type="date" value={condition.to ?? ""} onChange={(event) => set({ to: event.target.value })} aria-label="To" className="h-8 w-40" />
				</>
			)}

			{condition.type === "engagement" && (
				<>
					<Select value={condition.kind} onValueChange={(kind) => set({ kind })}>
						<SelectTrigger size="sm" className="w-56" aria-label="Engagement">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(ENGAGEMENT_LABELS).map(([kind, label]) => (
								<SelectItem key={kind} value={kind}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{condition.kind !== "never_opened" && (
						<>
							<Input
								type="number"
								min={1}
								max={3650}
								value={condition.days ?? ""}
								onChange={(event) => set({ days: event.target.value })}
								aria-label="Days"
								className="h-8 w-20"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</>
					)}
				</>
			)}

			{condition.type === "poll" && (
				<>
					<Select value={condition.poll} onValueChange={(id) => onChange({ type: "poll", poll: id, op: condition.op, option: 0 })}>
						<SelectTrigger size="sm" className="w-48" aria-label="Poll">
							<SelectValue placeholder="Pick a poll" />
						</SelectTrigger>
						<SelectContent>
							{polls.map(({ id, question }) => (
								<SelectItem key={id} value={id}>
									{question}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<OpSelect value={condition.op} onChange={setOp} options={POLL_OPS} />
					{SET_OPS.includes(condition.op) && poll && (
						<span className="flex flex-wrap gap-1.5">
							{poll.options.map((label, index) => {
								const isPicked = (condition.options ?? []).includes(index);
								return (
									<Button
										key={label}
										type="button"
										size="sm"
										variant={isPicked ? "default" : "outline"}
										aria-pressed={isPicked}
										onClick={() => set({ options: isPicked ? condition.options.filter((option) => option !== index) : [...(condition.options ?? []), index] })}
									>
										{label}
									</Button>
								);
							})}
						</span>
					)}
					{["is", "is_not"].includes(condition.op) && poll && (
						<Select value={String(condition.option ?? 0)} onValueChange={(option) => set({ option: Number(option) })}>
							<SelectTrigger size="sm" className="w-40" aria-label="Answer">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{poll.options.map((label, index) => (
									<SelectItem key={label} value={String(index)}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</>
			)}

			{condition.type === "imported" && (
				<Select value={condition.value === false ? "no" : "yes"} onValueChange={(value) => set({ value: value === "yes" })}>
					<SelectTrigger size="sm" className="w-36" aria-label="Imported">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="yes">Came from an import</SelectItem>
						<SelectItem value="no">Didn&apos;t</SelectItem>
					</SelectContent>
				</Select>
			)}

			{onRemove && (
				<Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove the condition" className="ml-auto text-muted-foreground hover:text-destructive">
					<Trash2 />
				</Button>
			)}
		</div>
	);
}

// Values separated by commas. What is typed stays as typed, so a comma at the end isn't lost.
function ValuesInput({ values, onChange, placeholder, label, list }) {
	const [text, setText] = useState((values ?? []).join(", "));
	return (
		<Input
			list={list}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				onChange(
					event.target.value
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean)
				);
			}}
			placeholder={placeholder}
			aria-label={label}
			className="h-8 w-56"
		/>
	);
}

function OpSelect({ value, onChange, options }) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Comparison">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map(([op, label]) => (
					<SelectItem key={op} value={op}>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
