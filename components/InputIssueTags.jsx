"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { setCampaignTags } from "@/app/(app)/campaigns/actions";
import { MAX_ISSUE_TAGS } from "@/lib/issue-tags";

// An issue's tags, separated by commas. They save when the field loses focus or on Enter, as the issue's web address does.
export default function InputIssueTags({ campaignId, initialTags = [] }) {
	const initial = initialTags.join(", ");
	const [saved, setSaved] = useState(initial);
	const [value, setValue] = useState(initial);
	const [error, setError] = useState(null);
	const [isSaved, setIsSaved] = useState(false);
	const [isSaving, startSaving] = useTransition();

	function save() {
		if (value.trim() === saved.trim() || isSaving) return;
		startSaving(async () => {
			const result = await setCampaignTags(campaignId, value);
			if (result?.error) return void setError(result.error);
			const next = result.tags.join(", ");
			setError(null);
			setSaved(next);
			setValue(next);
			setIsSaved(true);
			setTimeout(() => setIsSaved(false), 1500);
		});
	}

	return (
		<div className="flex min-w-0 flex-col gap-1.5 py-2.5">
			<div className="flex min-h-6 items-center gap-2">
				<input
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						setError(null);
					}}
					onBlur={save}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						save();
					}}
					placeholder="interviews, tools"
					aria-label="Tags"
					aria-invalid={Boolean(error)}
					spellCheck={false}
					autoComplete="off"
					className="h-6 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground/70"
				/>
				{isSaving ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : isSaved && <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
			</div>
			{error ? (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			) : (
				<p className="text-xs text-muted-foreground">Separate with commas, {MAX_ISSUE_TAGS} at most. Each tag gets a page on your website.</p>
			)}
		</div>
	);
}
