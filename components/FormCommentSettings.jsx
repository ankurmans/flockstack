"use client";

import { useState, useTransition } from "react";
import { saveCommentSettings } from "@/app/(app)/comments/actions";
import BarSave from "@/components/BarSave";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

const WHO = [
	["everyone", "Every active subscriber"],
	["paid", "Paid subscribers only"],
];
const MODERATION = [
	["none", "Show comments right away"],
	["hold_links", "Hold comments with a link for my review"],
	["hold_all", "Hold every comment for my review"],
];

function toDraft({ enabled, who, moderation, notifyOwner }) {
	return { enabled, who, moderation, notifyOwner };
}

// The newsletter's comment settings. Moderation is the owner's call: the rules here are only what holds a comment for review,
// and a held comment always says why to its author and to the owner.
export default function FormCommentSettings({ newsletterId, settings }) {
	const [draft, setDraft] = useState(() => toDraft(settings));
	const [saved, setSaved] = useState(() => JSON.stringify(toDraft(settings)));
	const [savedAt, setSavedAt] = useState(null);
	const [isSaving, startSaving] = useTransition();
	const isDirty = JSON.stringify(draft) !== saved;

	function set(patch) {
		setDraft((current) => ({ ...current, ...patch }));
	}

	function save(event) {
		event.preventDefault();
		startSaving(async () => {
			const result = await saveCommentSettings({ newsletterId, ...draft });
			if (result?.error) return void toast.error(result.error);
			setSaved(JSON.stringify(draft));
			setSavedAt(result.savedAt);
		});
	}

	function discard() {
		setDraft(toDraft(settings));
		setSaved(JSON.stringify(toDraft(settings)));
		setSavedAt(null);
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Comments" stagger={1} action={<Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Comments" />}>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Subscribers can comment on your web issues. They sign in with a link we email them, so there is no account or password, and other readers
					never see their email.
				</p>
				{!settings.hasWebsite && (
					<p className="px-4 py-3 text-sm text-pretty text-amber-700 dark:text-amber-400" role="status">
						Comments live on your website&apos;s issue pages. Turn the website on in the newsletter&apos;s settings first.
					</p>
				)}
				<RowSettings label="Who can comment">
					<Select value={draft.who} onValueChange={(who) => set({ who })}>
						<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Who can comment">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{WHO.map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</RowSettings>
				<RowSettings label="Review" hint="Whatever you hold waits on this page. Its writer sees that it is waiting, and why.">
					<Select value={draft.moderation} onValueChange={(moderation) => set({ moderation })}>
						<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Which comments wait for your review">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MODERATION.map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</RowSettings>
				<RowSettings label="Email me" hint="One email an hour at most, and only when there is something new.">
					<span className="flex items-center gap-2 pt-1.5 text-sm">
						<Switch checked={draft.notifyOwner} onCheckedChange={(notifyOwner) => set({ notifyOwner })} aria-label="Email me about new comments and reports" />
						About new comments and reports
					</span>
				</RowSettings>
			</CardSettings>
			<BarSave isDirty={isDirty} isSaving={isSaving} savedAt={savedAt} onDiscard={discard} />
		</form>
	);
}
