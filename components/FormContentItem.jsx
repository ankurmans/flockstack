"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { saveContentItem } from "@/app/(app)/campaigns/calendar/actions";
import BarSave from "@/components/BarSave";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FUNNEL_STAGES, LIMITS, LINKEDIN_MAX_CHARS } from "@/lib/content-rules";
import { toast } from "@/lib/toast";

const SELECT_CLASS = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

function toValues(item) {
	return {
		title: item.title,
		funnelStage: item.funnelStage ?? "",
		pillar: item.pillar ?? "",
		obstacle: item.obstacle,
		takeaway: item.takeaway,
		hook: item.hook,
		body: item.body,
		cta: item.cta,
		destinationUrl: item.destinationUrl,
		notes: item.notes,
		references: item.references.map((reference) => ({ ...reference })),
		batch: item.batchId ?? "",
	};
}

function Field({ id, label, hint, children }) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-sm font-medium">
				{label}
			</label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

// The item's copy, planning notes, call to action and references together. Saving keeps a revision; changing the words of an
// approved item takes the approval back, and the form says so.
export default function FormContentItem({ item, batches }) {
	const router = useRouter();
	const [values, setValues] = useState(() => toValues(item));
	const [savedKey, setSavedKey] = useState(() => JSON.stringify(toValues(item)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = JSON.stringify(values) !== savedKey;
	const isPost = item.channel === "linkedin";
	const set = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
	const setReference = (index, changes) => setValues((current) => ({ ...current, references: current.references.map((reference, position) => (position === index ? { ...reference, ...changes } : reference)) }));

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveContentItem(item.id, values);
			if (result?.error) return void toast.error(result.error);
			setSavedKey(JSON.stringify(values));
			setSavedAt(new Date().toISOString());
			toast.success("Saved");
			if (result.approvalWithdrawn) toast.message("This change took the approval back. Ask for a review again.");
			router.refresh();
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-5">
			<section className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border animate-enter" aria-label="Copy">
				<Field id="item-title" label="Title" hint={item.channel === "newsletter" ? "Left empty, the linked issue's subject is the title." : undefined}>
					<Input id="item-title" value={values.title} onChange={set("title")} maxLength={LIMITS.title} />
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="item-stage" label="Funnel stage">
						<select id="item-stage" value={values.funnelStage} onChange={set("funnelStage")} className={SELECT_CLASS}>
							<option value="">None</option>
							{FUNNEL_STAGES.map((stage) => (
								<option key={stage} value={stage}>
									{stage}
								</option>
							))}
						</select>
					</Field>
					<Field id="item-pillar" label="Content pillar">
						<Input id="item-pillar" value={values.pillar} onChange={set("pillar")} maxLength={LIMITS.pillar} />
					</Field>
				</div>
				<Field id="item-obstacle" label="Reader's obstacle" hint="The problem this speaks to.">
					<Textarea id="item-obstacle" value={values.obstacle} onChange={set("obstacle")} maxLength={LIMITS.obstacle} rows={2} />
				</Field>
				<Field id="item-takeaway" label="Takeaway" hint="What the reader should leave with.">
					<Textarea id="item-takeaway" value={values.takeaway} onChange={set("takeaway")} maxLength={LIMITS.takeaway} rows={2} />
				</Field>
				<Field id="item-hook" label="Hook" hint="The first line, what shows before 'see more'.">
					<Input id="item-hook" value={values.hook} onChange={set("hook")} maxLength={LIMITS.hook} />
				</Field>
				<Field id="item-body" label={isPost ? "Post" : "Description"} hint={isPost ? `${values.body.length} of ${LINKEDIN_MAX_CHARS} characters, the most LinkedIn takes.` : undefined}>
					<Textarea id="item-body" value={values.body} onChange={set("body")} maxLength={LIMITS.body} rows={isPost ? 12 : 5} aria-invalid={isPost && values.body.length > LINKEDIN_MAX_CHARS} />
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="item-cta" label="Call to action">
						<Input id="item-cta" value={values.cta} onChange={set("cta")} maxLength={LIMITS.cta} />
					</Field>
					<Field id="item-url" label="Destination address">
						<Input id="item-url" type="url" value={values.destinationUrl} onChange={set("destinationUrl")} placeholder="https://" maxLength={LIMITS.url} />
					</Field>
				</div>
			</section>

			<section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border animate-enter" aria-label="References and notes">
				<h2 className="text-sm font-medium">References and evidence</h2>
				{values.references.length === 0 && <p className="text-sm text-muted-foreground">No links yet.</p>}
				<ul className="flex flex-col gap-2">
					{values.references.map((reference, index) => (
						<li key={index} className="flex flex-wrap items-center gap-2">
							<select aria-label={`Link ${index + 1} kind`} value={reference.kind} onChange={(event) => setReference(index, { kind: event.target.value })} className={SELECT_CLASS}>
								<option value="reference">Reference</option>
								<option value="evidence">Evidence</option>
							</select>
							<Input aria-label={`Link ${index + 1} label`} value={reference.label ?? ""} onChange={(event) => setReference(index, { label: event.target.value })} placeholder="What it is" className="w-44" maxLength={LIMITS.label} />
							<Input aria-label={`Link ${index + 1} address`} type="url" value={reference.url} onChange={(event) => setReference(index, { url: event.target.value })} placeholder="https://" className="min-w-0 flex-1" maxLength={LIMITS.url} />
							<Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove link ${index + 1}`} onClick={() => setValues((current) => ({ ...current, references: current.references.filter((_, position) => position !== index) }))}>
								<X />
							</Button>
						</li>
					))}
				</ul>
				<div>
					<Button type="button" variant="outline" size="sm" disabled={values.references.length >= LIMITS.references} onClick={() => setValues((current) => ({ ...current, references: [...current.references, { label: "", url: "", kind: "reference" }] }))}>
						<Plus data-icon="inline-start" />
						Add a link
					</Button>
				</div>
				<Field id="item-notes" label="Private notes" hint="Only you and your agents see these. They are never part of the post.">
					<Textarea id="item-notes" value={values.notes} onChange={set("notes")} maxLength={LIMITS.notes} rows={4} />
				</Field>
				<Field id="item-batch" label="Batch">
					<select id="item-batch" value={values.batch} onChange={set("batch")} className={SELECT_CLASS}>
						<option value="">No batch</option>
						{batches.map((batch) => (
							<option key={batch.id} value={batch.id}>
								{batch.name}
							</option>
						))}
					</select>
				</Field>
			</section>
			<BarSave
				isDirty={isDirty}
				isSaving={isSaving}
				savedAt={savedAt}
				onDiscard={() => {
					setValues(JSON.parse(savedKey));
					setSavedAt(null);
				}}
			/>
		</form>
	);
}
