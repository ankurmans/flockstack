"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { saveDefaultStyle } from "@/app/(app)/templates/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ACCENT_PATTERN } from "@/lib/editor-blocks";
import { richToText, textToRich } from "@/lib/rich-text";
import { toast } from "@/lib/toast";

// The style new issues start with: a header and a footer around the place the writer starts, and the accent color of
// buttons, poll answers and links in the editor's blocks, which every issue uses.
export default function FormDefaultStyle({ newsletterId, defaultStyle, accentColor }) {
	const [draft, setDraft] = useState({ header: richToText(defaultStyle.header), footer: richToText(defaultStyle.footer), accentColor });
	const [isPending, startTransition] = useTransition();
	const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
	const isAccentValid = ACCENT_PATTERN.test(draft.accentColor);

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await saveDefaultStyle(newsletterId, { header: textToRich(draft.header), footer: textToRich(draft.footer), accentColor: draft.accentColor });
			if (result?.error) return void toast.error(result.error);
			toast.success("Default style saved");
		});
	}

	return (
		<form onSubmit={save}>
			<CardSettings title="Default style">
				<RowSettings label="Header" hint="At the top of every new issue. Paragraphs with a blank line between them, or HTML." isLabel>
					<Textarea value={draft.header} onChange={set("header")} rows={3} maxLength={20000} />
				</RowSettings>
				<RowSettings label="Footer" hint="At the bottom of every new issue, like a sign-off or a line about the sponsors" isLabel>
					<Textarea value={draft.footer} onChange={set("footer")} rows={3} maxLength={20000} />
				</RowSettings>
				<RowSettings label="Accent color" hint="The color of buttons, poll answers and links in your issues' blocks, like #1f6feb" isLabel>
					<span className="flex items-center gap-2">
						<span aria-hidden="true" className="size-6 shrink-0 rounded-md border" style={{ background: isAccentValid ? draft.accentColor : "transparent" }} />
						<Input value={draft.accentColor} onChange={set("accentColor")} maxLength={7} className="w-32" aria-invalid={!isAccentValid} />
					</span>
				</RowSettings>
				<div className="flex items-center gap-3 px-4 py-3">
					<Button type="submit" disabled={isPending || !isAccentValid}>
						{isPending && <Loader2 className="animate-spin" />}
						Save
					</Button>
					<span className="text-xs text-muted-foreground">They go into new issues as content you can change, so changing them leaves issues already started as they are.</span>
				</div>
			</CardSettings>
		</form>
	);
}
