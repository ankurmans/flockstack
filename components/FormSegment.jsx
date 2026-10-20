"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createSegment, createSegmentList, previewSegmentRules, updateSegment } from "@/app/(app)/segments/actions";
import CardSettings from "@/components/CardSettings";
import EditorRules from "@/components/EditorRules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { rulesFromState, stateFromRules } from "@/lib/rules-state";
import { toast } from "@/lib/toast";

const DEBOUNCE_MS = 450;

// A segment's name and its rules, with the contacts they match counted as they change.
// polls: the newsletter's, { id, question, options }, for conditions on what subscribers answered. issues: sent issues with
// their links, { id, subject, links: [{ index, url }] }. lists: the saved lists, { id, name }.
export default function FormSegment({ newsletter, segment, fields, tags, polls = [], issues = [], lists = [] }) {
	const router = useRouter();
	const [name, setName] = useState(segment?.name ?? "");
	const [description, setDescription] = useState(segment?.description ?? "");
	const [state, setState] = useState(() => stateFromRules(segment?.rules));
	const [preview, setPreview] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const rules = rulesFromState(state);
	const rulesKey = JSON.stringify(rules);
	const isList = segment?.kind === "static";

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
				? await updateSegment(segment.id, isList ? { name, description } : { name, description, rules })
				: await createSegment({ newsletterId: newsletter.id, name, description, rules });
			if (result?.error) return void toast.error(result.error);
			toast.success(segment ? "Segment saved" : "Segment created");
			router.push("/segments");
		});
	}

	// The contacts the rules match now, kept as a list that doesn't follow the newsletter afterwards.
	function saveList() {
		startSaving(async () => {
			const result = await createSegmentList({ newsletterId: newsletter.id, name, description, rules });
			if (result?.error) return void toast.error(result.error);
			toast.success(result.status === "building" ? "Saving the list: it will be ready in a few minutes" : "List saved");
			router.push("/segments");
		});
	}

	return (
		<div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
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

				{isList ? (
					<CardSettings title="Saved list" stagger={1}>
						<p className="p-4 text-sm text-pretty text-muted-foreground">
							{segment.status === "building"
								? "This list is still being saved. It can be sent to once it's ready."
								: segment.status === "failed"
									? "This list couldn't be saved. Delete it and save it again."
									: `${formatNumber(segment.members ?? 0)} contacts, saved ${segment.savedAt ? new Date(segment.savedAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : ""}. People who join later aren't on it, and its contacts can't change.`}
						</p>
					</CardSettings>
				) : (
					<CardSettings title="Rules" stagger={1}>
						<div className="p-4">
							<EditorRules state={state} onChange={setState} fields={fields} tags={tags} polls={polls} issues={issues} lists={lists} />
						</div>
					</CardSettings>
				)}

				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={() => router.push("/segments")} disabled={isSaving}>
						Cancel
					</Button>
					{!isList && (
						<Button variant="outline" onClick={saveList} disabled={isSaving || !name.trim() || state.items.length === 0}>
							Save as a list
						</Button>
					)}
					<Button onClick={save} disabled={isSaving || !name.trim() || state.items.length === 0} className="min-w-24">
						{isSaving ? <Loader2 className="animate-spin" /> : "Save"}
					</Button>
				</div>
			</div>

			<CardPreview preview={preview} />
		</div>
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
