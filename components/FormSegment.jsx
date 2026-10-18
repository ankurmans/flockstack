"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { createSegment, previewSegmentRules, updateSegment } from "@/app/(app)/segments/actions";
import CardSettings from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

const STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];
const TYPE_LABELS = {
	status: "Status",
	tag: "Tag",
	field: "Custom field",
	signup_date: "Signup date",
	source: "Source",
	engagement: "Engagement",
	imported: "Imported",
};
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
};
const DEBOUNCE_MS = 450;

function newCondition() {
	return { type: "tag", op: "has", value: "" };
}

function isGroup(item) {
	return Array.isArray(item.conditions);
}

// What the builder holds is what the action takes, minus the parts of a condition its type doesn't use.
function cleanCondition(condition) {
	const { type } = condition;
	if (type === "field") return { type, field: condition.field, op: condition.op, ...(!["is_set", "is_not_set"].includes(condition.op) && { value: condition.value }) };
	if (type === "signup_date") return { type, ...(condition.from && { from: condition.from }), ...(condition.to && { to: condition.to }) };
	if (type === "engagement") return { type, kind: condition.kind, ...(condition.kind !== "never_opened" && { days: Number(condition.days) || undefined }) };
	if (type === "imported") return { type, value: condition.value !== false };
	return { type, op: condition.op, value: condition.value };
}

function toRules({ match, items }) {
	return {
		match,
		conditions: items.map((item) => (isGroup(item) ? { match: item.match, conditions: item.conditions.map(cleanCondition) } : cleanCondition(item))),
	};
}

function fromRules(rules) {
	return { match: rules?.match ?? "all", items: rules?.conditions?.length ? rules.conditions : [newCondition()] };
}

// A segment's name and its rules, with the contacts they match counted as they change.
export default function FormSegment({ newsletter, segment, fields, tags }) {
	const router = useRouter();
	const [name, setName] = useState(segment?.name ?? "");
	const [description, setDescription] = useState(segment?.description ?? "");
	const [state, setState] = useState(() => fromRules(segment?.rules));
	const [preview, setPreview] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const rules = toRules(state);
	const rulesKey = JSON.stringify(rules);

	useEffect(() => {
		let isCurrent = true;
		const timer = setTimeout(async () => {
			const result = await previewSegmentRules(newsletter.id, JSON.parse(rulesKey));
			if (isCurrent) setPreview(result);
		}, DEBOUNCE_MS);
		return () => {
			isCurrent = false;
			clearTimeout(timer);
		};
	}, [newsletter.id, rulesKey]);

	function save() {
		startSaving(async () => {
			const result = segment
				? await updateSegment(segment.id, { name, description, rules })
				: await createSegment({ newsletterId: newsletter.id, name, description, rules });
			if (result?.error) return void toast.error(result.error);
			toast.success(segment ? "Segment saved" : "Segment created");
			router.push("/segments");
		});
	}

	function setItem(index, item) {
		setState((current) => ({ ...current, items: current.items.map((existing, position) => (position === index ? item : existing)) }));
	}

	function removeItem(index) {
		setState((current) => ({ ...current, items: current.items.filter((_, position) => position !== index) }));
	}

	return (
		<div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="flex flex-col gap-6">
				<CardSettings title="Segment">
					<div className="flex flex-col gap-3 p-4">
						<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Engaged readers" aria-label="Name" maxLength={80} className="h-9" />
						<Input
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="What it's for (optional)"
							aria-label="Description"
							maxLength={300}
							className="h-9"
						/>
					</div>
				</CardSettings>

				<CardSettings title="Rules" stagger={1}>
					<div className="flex flex-col gap-3 p-4">
						<div className="flex flex-wrap items-center gap-2 text-sm">
							Contacts who match
							<MatchSelect value={state.match} onChange={(match) => setState((current) => ({ ...current, match }))} />
							of these:
						</div>
						{state.items.map((item, index) =>
							isGroup(item) ? (
								<Group
									key={index}
									group={item}
									fields={fields}
									tags={tags}
									onChange={(group) => setItem(index, group)}
									onRemove={() => removeItem(index)}
								/>
							) : (
								<Condition key={index} condition={item} fields={fields} tags={tags} onChange={(condition) => setItem(index, condition)} onRemove={() => removeItem(index)} />
							)
						)}
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" size="sm" onClick={() => setState((current) => ({ ...current, items: [...current.items, newCondition()] }))}>
								<Plus data-icon="inline-start" />
								Condition
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setState((current) => ({ ...current, items: [...current.items, { match: "any", conditions: [newCondition()] }] }))}
							>
								<Plus data-icon="inline-start" />
								Group
							</Button>
						</div>
					</div>
				</CardSettings>

				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={() => router.push("/segments")} disabled={isSaving}>
						Cancel
					</Button>
					<Button onClick={save} disabled={isSaving || !name.trim() || state.items.length === 0} className="min-w-24">
						{isSaving ? <Loader2 className="animate-spin" /> : "Save"}
					</Button>
				</div>
			</div>

			<CardPreview preview={preview} />
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

function Group({ group, fields, tags, onChange, onRemove }) {
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

function defaultsFor(type, fields) {
	switch (type) {
		case "status":
			return { type, op: "is", value: "active" };
		case "tag":
			return { type, op: "has", value: "" };
		case "source":
			return { type, op: "is", value: "" };
		case "field":
			return { type, field: fields[0]?.key ?? "", op: "eq", value: "" };
		case "signup_date":
			return { type, from: "", to: "" };
		case "engagement":
			return { type, kind: "opened", days: 30 };
		default:
			return { type, value: true };
	}
}

function Condition({ condition, fields, tags, onChange, onRemove }) {
	const listId = useId();
	const field = fields.find(({ key }) => key === condition.field);
	const set = (changes) => onChange({ ...condition, ...changes });

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select value={condition.type} onValueChange={(type) => onChange(defaultsFor(type, fields))}>
				<SelectTrigger size="sm" className="w-36" aria-label="Condition">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(TYPE_LABELS)
						.filter(([type]) => type !== "field" || fields.length > 0)
						.map(([type, label]) => (
							<SelectItem key={type} value={type}>
								{label}
							</SelectItem>
						))}
				</SelectContent>
			</Select>

			{condition.type === "status" && (
				<>
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={[["is", "is"], ["is_not", "is not"]]} />
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
				</>
			)}

			{condition.type === "tag" && (
				<>
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={[["has", "has"], ["has_not", "doesn't have"]]} />
					<Input
						list={listId}
						value={condition.value}
						onChange={(event) => set({ value: event.target.value })}
						placeholder="Tag"
						aria-label="Tag"
						maxLength={60}
						className="h-8 w-40"
					/>
					<datalist id={listId}>
						{tags.map((tag) => (
							<option key={tag} value={tag} />
						))}
					</datalist>
				</>
			)}

			{condition.type === "source" && (
				<>
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={[["is", "is"], ["is_not", "is not"]]} />
					<Input value={condition.value} onChange={(event) => set({ value: event.target.value })} placeholder="e.g. website" aria-label="Source" maxLength={100} className="h-8 w-40" />
				</>
			)}

			{condition.type === "field" && (
				<>
					<Select value={condition.field} onValueChange={(key) => onChange({ type: "field", field: key, op: "eq", value: "" })}>
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
					<OpSelect value={condition.op} onChange={(op) => set({ op })} options={FIELD_OPS[field?.type ?? "text"]} />
					{!["is_set", "is_not_set"].includes(condition.op) && (
						<Input
							type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"}
							step={field?.type === "number" ? "any" : undefined}
							value={condition.value ?? ""}
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

function OpSelect({ value, onChange, options }) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className="w-36" aria-label="Comparison">
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

function CardPreview({ preview }) {
	return (
		<aside className="h-fit rounded-xl bg-card shadow-border lg:sticky lg:top-6">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Who matches now</h2>
			<div className="border-t border-border/60 p-4">
				{!preview ? (
					<p className="text-sm text-muted-foreground">Counting…</p>
				) : preview.error ? (
					<p className="text-sm text-pretty text-muted-foreground">{preview.error}</p>
				) : (
					<>
						<dl className="grid grid-cols-3 gap-2 text-center">
							<Count label="Matching" value={preview.matching} />
							<Count label="Active" value={preview.active} />
							<Count label="Can get email" value={preview.sendable} />
						</dl>
						{preview.sample.length > 0 && (
							<ul className="mt-4 flex flex-col gap-1 text-sm">
								{preview.sample.map((contact) => (
									<li key={contact.id} className="truncate text-muted-foreground">
										{contact.email}
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

function Count({ label, value }) {
	return (
		<div>
			<dd className="text-xl font-semibold tabular-nums">{formatNumber(value)}</dd>
			<dt className="text-xs text-muted-foreground">{label}</dt>
		</div>
	);
}
