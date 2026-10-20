"use client";

import { useEditorState } from "@tiptap/react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { countWords, formatReadTime } from "@/lib/read-time";

// Under the editor's text: its words and reading time, live, and the selection's words while one is selected.
export default function FooterEditor({ editor, onFind }) {
	const { words, selected } = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			const { from, to } = current.state.selection;
			return {
				words: countWords(current.getText({ blockSeparator: "\n" })),
				selected: from === to ? 0 : countWords(current.state.doc.textBetween(from, to, "\n", " ")),
			};
		},
	});

	return (
		<div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-1.5 text-xs text-muted-foreground tabular-nums">
			<span aria-live="off">
				{selected > 0 && `${formatNumber(selected)} of `}
				{formatNumber(words)} {words === 1 ? "word" : "words"}
				{words > 0 && ` · ${formatReadTime(words)}`}
			</span>
			<Button variant="ghost" size="xs" onClick={onFind} aria-label="Find and replace" title="Find and replace (Cmd/Ctrl+F)">
				<Search data-icon="inline-start" />
				Find
			</Button>
		</div>
	);
}
