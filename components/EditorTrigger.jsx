"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const TRIGGERS = {
	subscribed: "A contact subscribes",
	tag_added: "A contact gets a tag",
	tag_removed: "A contact loses a tag",
	segment_joined: "A contact joins a segment",
	segment_left: "A contact leaves a segment",
	date_field: "A date field's day arrives",
	field_changed: "A custom field changes",
	upgraded: "A reader upgrades to paid",
	downgraded: "A reader drops to free",
	product_bought: "A reader buys a product",
	referral_credited: "A referral is credited",
	unengaged: "A contact stops opening",
	link_clicked: "A contact clicks a link",
	manual: "You add contacts by hand",
	api: "Your code adds contacts",
};

// The trigger as update_automation takes it: only what its type uses.
export function toTriggerInput(trigger) {
	const { type } = trigger;
	switch (type) {
		case "subscribed":
			return { type, ...(trigger.tag && { tag: trigger.tag }), ...(trigger.source && { source: trigger.source }) };
		case "tag_added":
		case "tag_removed":
			return { type, tag: trigger.tag ?? "" };
		case "segment_joined":
			return { type, segment: trigger.segment ?? "", includeExisting: Boolean(trigger.includeExisting) };
		case "segment_left":
			return { type, segment: trigger.segment ?? "" };
		case "field_changed":
			return { type, field: trigger.field ?? "" };
		case "product_bought":
			return { type, ...(trigger.product && { product: trigger.product }) };
		case "referral_credited":
			return { type, ...(Number(trigger.referrals) > 0 && { referrals: Number(trigger.referrals) }) };
		case "unengaged":
			return { type, days: Number(trigger.days) || 0, includeExisting: Boolean(trigger.includeExisting) };
		case "link_clicked":
			return { type, url: trigger.url ?? "", ...(trigger.campaign && { campaign: trigger.campaign }) };
		case "date_field":
			return { type, field: trigger.field ?? "", offsetDays: Number(trigger.offsetDays) || 0, repeat: trigger.repeat ?? "once" };
		default:
			return { type };
	}
}

const EXTRA_BY_TYPE = {
	unengaged: { days: 60 },
	manual: {},
	api: {},
};

// What starts an automation. choices and the lists are the newsletter's (lib/segment-choices.js and the page).
export default function EditorTrigger({ trigger, onChange, segments, choices, products, isDisabled }) {
	const listId = useId();
	const set = (changes) => onChange({ ...trigger, ...changes });
	const dateFields = choices.fields.filter(({ type }) => type === "date");

	return (
		<>
			<Select value={trigger.type} onValueChange={(type) => onChange({ type, ...EXTRA_BY_TYPE[type] })} disabled={isDisabled}>
				<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Trigger">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(TRIGGERS).map(([type, label]) => (
						<SelectItem key={type} value={type}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{["subscribed", "tag_added", "tag_removed"].includes(trigger.type) && (
				<>
					<Input
						list={listId}
						value={trigger.tag ?? ""}
						onChange={(event) => set({ tag: event.target.value })}
						placeholder={trigger.type === "subscribed" ? "Only with a tag, e.g. vip" : "Tag"}
						aria-label={trigger.type === "subscribed" ? "Only contacts who signed up with this tag" : "Tag"}
						maxLength={60}
						disabled={isDisabled}
						className="h-9"
					/>
					<datalist id={listId}>
						{choices.tags.map((tag) => (
							<option key={tag} value={tag} />
						))}
					</datalist>
				</>
			)}
			{trigger.type === "subscribed" && (
				<Input
					value={trigger.source ?? ""}
					onChange={(event) => set({ source: event.target.value })}
					placeholder="Only from a source, e.g. website"
					aria-label="Only contacts from this source"
					maxLength={100}
					disabled={isDisabled}
					className="h-9"
				/>
			)}

			{["segment_joined", "segment_left"].includes(trigger.type) && (
				<>
					{segments.length === 0 ? (
						<p className="text-sm text-muted-foreground">Create a segment first.</p>
					) : (
						<Select value={trigger.segment ?? ""} onValueChange={(segment) => set({ segment })} disabled={isDisabled}>
							<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Segment">
								<SelectValue placeholder="Pick a segment" />
							</SelectTrigger>
							<SelectContent>
								{segments.map((segment) => (
									<SelectItem key={segment.id} value={segment.id}>
										{segment.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<p className="text-xs text-muted-foreground">The segment is checked about every hour.</p>
				</>
			)}
			{trigger.type === "segment_joined" && (
				<CheckExisting
					checked={trigger.includeExisting}
					onChange={(includeExisting) => set({ includeExisting })}
					isDisabled={isDisabled}
					label="Also start it for the contacts already in the segment"
					help="Otherwise it starts for those who join after it's activated."
				/>
			)}

			{trigger.type === "date_field" && (
				<>
					{dateFields.length === 0 ? (
						<p className="text-sm text-muted-foreground">Add a date custom field first, from Tags and fields on the contacts page.</p>
					) : (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Input
								type="number"
								min={-365}
								max={365}
								value={trigger.offsetDays ?? 0}
								onChange={(event) => set({ offsetDays: event.target.value })}
								aria-label="Days"
								disabled={isDisabled}
								className="h-9 w-20"
							/>
							days after the date in
							<FieldSelect fields={dateFields} value={trigger.field} onChange={(field) => set({ field })} isDisabled={isDisabled} />
							<Select value={trigger.repeat ?? "once"} onValueChange={(repeat) => set({ repeat })} disabled={isDisabled}>
								<SelectTrigger className="h-9 w-36" aria-label="Repeat">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="once">Once</SelectItem>
									<SelectItem value="yearly">Every year</SelectItem>
								</SelectContent>
							</Select>
							<span className="basis-full text-xs text-muted-foreground">Negative days start it before the date.</span>
						</div>
					)}
				</>
			)}

			{trigger.type === "field_changed" &&
				(choices.fields.length === 0 ? (
					<p className="text-sm text-muted-foreground">Add a custom field first, from Tags and fields on the contacts page.</p>
				) : (
					<FieldSelect fields={choices.fields} value={trigger.field} onChange={(field) => set({ field })} isDisabled={isDisabled} />
				))}

			{trigger.type === "product_bought" && (
				<Select value={trigger.product || "any"} onValueChange={(product) => set({ product: product === "any" ? "" : product })} disabled={isDisabled}>
					<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Product">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="any">Any product</SelectItem>
						{products.map((product) => (
							<SelectItem key={product.id} value={product.id}>
								{product.title}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			{trigger.type === "referral_credited" && (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					Only when they reach
					<Input
						type="number"
						min={1}
						value={trigger.referrals ?? ""}
						onChange={(event) => set({ referrals: event.target.value })}
						placeholder="any"
						aria-label="Referrals"
						disabled={isDisabled}
						className="h-9 w-24"
					/>
					referrals
					<span className="basis-full text-xs text-muted-foreground">Leave it empty to start it for every referral that is credited.</span>
				</div>
			)}

			{trigger.type === "unengaged" && (
				<>
					<div className="flex flex-wrap items-center gap-2 text-sm">
						No opens or clicks for
						<Input type="number" min={1} max={3650} value={trigger.days ?? ""} onChange={(event) => set({ days: event.target.value })} aria-label="Days" disabled={isDisabled} className="h-9 w-24" />
						days
					</div>
					<CheckExisting
						checked={trigger.includeExisting}
						onChange={(includeExisting) => set({ includeExisting })}
						isDisabled={isDisabled}
						label="Also start it for the contacts who are already quiet"
						help="Otherwise it starts for those who go quiet after it's activated. Looked at once a day."
					/>
				</>
			)}

			{trigger.type === "link_clicked" && (
				<>
					<Input
						value={trigger.url ?? ""}
						onChange={(event) => set({ url: event.target.value })}
						placeholder="https://example.com/offer"
						aria-label="The link's address"
						maxLength={2000}
						disabled={isDisabled}
						className="h-9"
					/>
					<Select value={trigger.campaign || "any"} onValueChange={(campaign) => set({ campaign: campaign === "any" ? "" : campaign })} disabled={isDisabled}>
						<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Issue">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="any">In any issue</SelectItem>
							{choices.issues.map((issue) => (
								<SelectItem key={issue.id} value={issue.id}>
									{issue.subject || "No subject"}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">The first time a contact clicks that link. The address is the one in the issue, without the tracking.</p>
				</>
			)}

			{trigger.type === "manual" && <p className="text-sm text-pretty text-muted-foreground">Add contacts from this page once it&apos;s active. A contact enters once.</p>}
			{trigger.type === "api" && (
				<p className="text-sm text-pretty text-muted-foreground">
					Your code starts it with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">POST /api/v1/automations/&#123;id&#125;/enroll</code> or the
					enroll_contacts tool.
				</p>
			)}
		</>
	);
}

function FieldSelect({ fields, value, onChange, isDisabled }) {
	return (
		<Select value={value ?? ""} onValueChange={onChange} disabled={isDisabled}>
			<SelectTrigger className="h-9 w-44" aria-label="Custom field">
				<SelectValue placeholder="Pick a field" />
			</SelectTrigger>
			<SelectContent>
				{fields.map((field) => (
					<SelectItem key={field.key} value={field.key}>
						{field.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function CheckExisting({ checked, onChange, isDisabled, label, help }) {
	return (
		<label className="flex items-start gap-2.5 text-sm">
			<input
				type="checkbox"
				checked={Boolean(checked)}
				onChange={(event) => onChange(event.target.checked)}
				disabled={isDisabled}
				className="mt-0.5 size-4 shrink-0 accent-foreground"
			/>
			<span>
				{label}
				<span className="block text-xs text-muted-foreground">{help}</span>
			</span>
		</label>
	);
}
