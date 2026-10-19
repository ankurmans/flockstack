"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EMBED_PROVIDERS, parseEmbed } from "@/lib/embeds";

const COPY = {
	ctaButton: { title: "Button", description: "A button in the newsletter's accent color, centered.", save: "Save button" },
	embed: {
		title: "Embed",
		description: `A link to a post or video on ${Object.values(EMBED_PROVIDERS)
			.map(({ name }) => name)
			.join(", ")}. The web page plays it; emails show a picture or a card that links to it.`,
		save: "Embed",
	},
	footnote: { title: "Footnote", description: "Numbered where you put it and listed at the end of the issue.", save: "Save note" },
};

// The dialog of a block that is set up with a few fields. block: { kind, attrs, pos } (pos null for a new one).
// onSave(attrs) puts it in the issue.
export default function DialogEditorBlock({ block, onOpenChange, onSave }) {
	return (
		<Dialog open={Boolean(block)} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				{block && <FormBlock key={`${block.kind}-${block.pos ?? "new"}`} block={block} onSave={onSave} />}
			</DialogContent>
		</Dialog>
	);
}

function FormBlock({ block, onSave }) {
	const [values, setValues] = useState(block.attrs ?? {});
	const [error, setError] = useState("");
	const copy = COPY[block.kind];
	const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));

	function submit(event) {
		event.preventDefault();
		const problem = getProblem(block.kind, values);
		if (problem) return void setError(problem);
		onSave(toAttrs(block.kind, values));
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>{copy.title}</DialogTitle>
				<DialogDescription>{copy.description}</DialogDescription>
			</DialogHeader>
			{block.kind === "ctaButton" && (
				<>
					<label className="flex flex-col gap-1.5 text-sm">
						Label
						<Input value={values.label ?? ""} onChange={set("label")} placeholder="Read the full story" maxLength={60} autoFocus />
					</label>
					<label className="flex flex-col gap-1.5 text-sm">
						Link
						<Input value={values.href ?? ""} onChange={set("href")} placeholder="https://" maxLength={2000} inputMode="url" />
					</label>
				</>
			)}
			{block.kind === "embed" && (
				<label className="flex flex-col gap-1.5 text-sm">
					Link
					<Input value={values.url ?? ""} onChange={set("url")} placeholder="https://www.youtube.com/watch?v=…" maxLength={500} inputMode="url" autoFocus />
				</label>
			)}
			{block.kind === "footnote" && (
				<label className="flex flex-col gap-1.5 text-sm">
					Note
					<Textarea value={values.text ?? ""} onChange={set("text")} maxLength={1000} rows={3} autoFocus />
				</label>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter>
				<Button type="submit">{copy.save}</Button>
			</DialogFooter>
		</form>
	);
}

function getProblem(kind, values) {
	if (kind === "ctaButton") {
		if (!values.label?.trim()) return "Give the button a label";
		if (!/^https?:\/\/\S+\.\S+/i.test(values.href?.trim() ?? "")) return "The link has to start with https://";
	}
	if (kind === "embed" && !parseEmbed(values.url)) return "Paste a link to a YouTube video or a post on X, Instagram, TikTok, Bluesky, Spotify or Apple Podcasts";
	if (kind === "footnote" && !values.text?.trim()) return "Write the note";
	return null;
}

function toAttrs(kind, values) {
	if (kind === "ctaButton") return { label: values.label.trim(), href: values.href.trim() };
	if (kind === "embed") return { url: parseEmbed(values.url).url };
	return { text: values.text.trim() };
}
