"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { updatePopup } from "@/app/(app)/forms/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { POPUP_LIMITS } from "@/lib/popup-rules";
import { toast } from "@/lib/toast";

const SELECT = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm";
const TRIGGERS = [
	["scroll", "When the reader is part-way down the page"],
	["time", "After a number of seconds"],
	["exit", "When the mouse leaves through the top of the window (desktop only)"],
];

// The website's signup pop-up and the gate, as get_popup_settings has them.
export default function FormPopup({ newsletterId, settings }) {
	const [draft, setDraft] = useState(() => ({ ...settings, gate: { ...settings.gate } }));
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
	const setGate = (key, value) => setDraft((current) => ({ ...current, gate: { ...current.gate, [key]: value } }));
	const number = (value) => (value === "" ? 0 : Number(value));

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await updatePopup(newsletterId, draft);
			if (result?.error) return void toast.error(result.error);
			toast.success("Pop-up saved");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings
				title="Pop-up"
				action={<Switch checked={draft.enabled} onCheckedChange={(isChecked) => set("enabled", isChecked)} aria-label="Show the signup pop-up on the website" />}
			>
				{draft.enabled && (
					<>
						<RowSettings label="Opens" hint="Never for someone who signed up in their browser or is signed in to the website.">
							{TRIGGERS.map(([value, label]) => (
								<label key={value} className="flex items-start gap-2 text-sm">
									<input type="radio" name="trigger" value={value} checked={draft.trigger === value} onChange={() => set("trigger", value)} className="mt-1 size-4 accent-foreground" />
									{label}
								</label>
							))}
						</RowSettings>
						{draft.trigger === "scroll" && (
							<RowSettings label="Scrolled to" isLabel>
								<span className="flex items-center gap-2 text-sm">
									<Input type="number" min={POPUP_LIMITS.scrollPercent.min} max={POPUP_LIMITS.scrollPercent.max} value={draft.scrollPercent} onChange={(event) => set("scrollPercent", number(event.target.value))} className="w-24" />% of the page
								</span>
							</RowSettings>
						)}
						{draft.trigger === "time" && (
							<RowSettings label="After" isLabel>
								<span className="flex items-center gap-2 text-sm">
									<Input type="number" min={POPUP_LIMITS.seconds.min} max={POPUP_LIMITS.seconds.max} value={draft.seconds} onChange={(event) => set("seconds", number(event.target.value))} className="w-24" />seconds
								</span>
							</RowSettings>
						)}
						<RowSettings label="Shows on" isLabel>
							<select value={draft.pages} onChange={(event) => set("pages", event.target.value)} className={SELECT}>
								<option value="issues">Issue pages</option>
								<option value="home">The front page</option>
								<option value="all">The front page, issues and the author page</option>
							</select>
						</RowSettings>
						<RowSettings label="After it's closed" hint="A flag in the reader's own browser storage, not a cookie: nothing about them is sent to us." isLabel>
							<span className="flex items-center gap-2 text-sm">
								Stay away for
								<Input type="number" min={POPUP_LIMITS.frequencyDays.min} max={POPUP_LIMITS.frequencyDays.max} value={draft.frequencyDays} onChange={(event) => set("frequencyDays", number(event.target.value))} className="w-24" />days
							</span>
						</RowSettings>
					</>
				)}
			</CardSettings>

			<CardSettings
				title="Gate issues"
				action={<Switch checked={draft.gate.enabled} onCheckedChange={(isChecked) => setGate("enabled", isChecked)} aria-label="Show only the beginning of issues to readers who haven't subscribed" />}
			>
				{draft.gate.enabled ? (
					<>
						<RowSettings label="Preview" hint="Plain text, the first part of the issue. The rest, the RSS feed included, needs a subscriber who is signed in to the website: through a link in an email, or by confirming their address." isLabel>
							<span className="flex items-center gap-2 text-sm">
								<Input type="number" min={POPUP_LIMITS.previewPercent.min} max={POPUP_LIMITS.previewPercent.max} value={draft.gate.previewPercent} onChange={(event) => setGate("previewPercent", number(event.target.value))} className="w-24" />% of the text
							</span>
						</RowSettings>
						<RowSettings label="Keep open" hint="The newest issues stay open to everyone, so a visitor from search or a share sees what you write. Paid issues keep their own teaser." isLabel>
							<span className="flex items-center gap-2 text-sm">
								The newest
								<Input type="number" min={POPUP_LIMITS.freeLatest.min} max={POPUP_LIMITS.freeLatest.max} value={draft.gate.freeLatest} onChange={(event) => setGate("freeLatest", number(event.target.value))} className="w-24" />issues
							</span>
						</RowSettings>
					</>
				) : (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
						Off. Turn it on to show older issues to people who haven&apos;t subscribed as their beginning and a signup form.
					</p>
				)}
			</CardSettings>

			<div>
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
			</div>
		</form>
	);
}
