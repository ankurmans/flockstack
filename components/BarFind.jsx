"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import { ArrowDown, ArrowUp, CaseSensitive, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findKey } from "@/lib/editor-find";
import { cn } from "@/lib/utils";

// Find and replace above the editor's text (lib/editor-find.js). Enter goes to the next match, Shift+Enter to the previous
// one, Escape closes the bar and clears the highlights.
export default function BarFind({ editor, initialQuery = "", onClose }) {
	const [query, setQuery] = useState(initialQuery);
	const [replacement, setReplacement] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const inputRef = useRef(null);
	const { count, index } = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			const { matches, index: at } = findKey.getState(current.state);
			return { count: matches.length, index: at };
		},
	});

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	useEffect(() => {
		editor.commands.setFind({ query, caseSensitive });
	}, [editor, query, caseSensitive]);

	useEffect(
		() => () => {
			if (!editor.isDestroyed) editor.commands.setFind({ query: "" });
		},
		[editor]
	);

	// The current match comes into view without the editor taking focus from the bar.
	useEffect(() => {
		const match = findKey.getState(editor.state).matches[index];
		if (!match) return;
		const { node } = editor.view.domAtPos(match.from);
		(node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [editor, index, count, query]);

	function onKeyDown(event) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		} else if (event.key === "Enter") {
			event.preventDefault();
			editor.commands.findStep(event.shiftKey ? -1 : 1);
		}
	}

	return (
		<div role="search" aria-label="Find and replace" className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
			<input
				ref={inputRef}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder="Find"
				aria-label="Find"
				className="h-8 w-40 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<input
				value={replacement}
				onChange={(event) => setReplacement(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder="Replace with"
				aria-label="Replace with"
				className="h-8 w-40 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<span className="min-w-14 text-xs text-muted-foreground tabular-nums" aria-live="polite">
				{query ? (count === 0 ? "No matches" : `${index + 1} of ${count}`) : ""}
			</span>
			<Button variant="ghost" size="icon-sm" aria-label="Previous match" onClick={() => editor.commands.findStep(-1)} disabled={count === 0}>
				<ArrowUp />
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Next match" onClick={() => editor.commands.findStep(1)} disabled={count === 0}>
				<ArrowDown />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Match case"
				aria-pressed={caseSensitive}
				onClick={() => setCaseSensitive((current) => !current)}
				className={cn(caseSensitive && "bg-accent")}
			>
				<CaseSensitive />
			</Button>
			<Button variant="outline" size="sm" onClick={() => editor.commands.replaceCurrent(replacement)} disabled={count === 0}>
				Replace
			</Button>
			<Button variant="outline" size="sm" onClick={() => editor.commands.replaceAll(replacement)} disabled={count === 0}>
				Replace all
			</Button>
			<Button variant="ghost" size="icon-sm" aria-label="Close find and replace" onClick={onClose}>
				<X />
			</Button>
		</div>
	);
}
