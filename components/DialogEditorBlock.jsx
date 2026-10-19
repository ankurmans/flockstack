"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { createPoll, getPoll, updatePoll } from "@/app/(app)/campaigns/actions";
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
	poll: {
		title: "Poll",
		description: "Each answer in the email is a one-click vote. Readers land on a thank-you page; subscribers can change their vote.",
		save: "Save poll",
	},
};
const MAX_OPTIONS = 6;

// The dialog of a block that is set up with a few fields. block: { kind, attrs, pos } (pos null for a new one).
// onSave(attrs) puts it in the issue. A poll is saved first (create_poll, update_poll), in newsletterId and campaignId.
export default function DialogEditorBlock({ block, onOpenChange, onSave, newsletterId, campaignId, fields = [] }) {
	return (
		<Dialog open={Boolean(block)} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				{block?.kind === "poll" ? (
					<FormPoll key={`poll-${block.pos ?? "new"}`} block={block} onSave={onSave} newsletterId={newsletterId} campaignId={campaignId} fields={fields} />
				) : (
					block && <FormBlock key={`${block.kind}-${block.pos ?? "new"}`} block={block} onSave={onSave} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function FormPoll({ block, onSave, newsletterId, campaignId, fields }) {
	const pollId = block.attrs?.id || null;
	const [poll, setPoll] = useState(() => ({
		question: block.attrs?.question ?? "",
		options: (block.attrs?.options?.length ? block.attrs.options : ["", ""]).map((label) => ({ label, tag: "" })),
		fieldKey: "",
		showResults: true,
		followUp: "",
	}));
	const [error, setError] = useState("");
	const [isPending, startTransition] = useTransition();
	const choices = fields.filter(({ type }) => type === "text" || type === "list");

	// An existing poll's tags and settings live with the poll, not in the issue.
	useEffect(() => {
		if (!pollId) return;
		let isCurrent = true;
		getPoll(pollId).then((result) => {
			if (!isCurrent || !result?.poll) return;
			const { question, options, fieldKey, showResults, followUp } = result.poll;
			setPoll({ question, options: options.map(({ label, tag }) => ({ label, tag: tag ?? "" })), fieldKey: fieldKey ?? "", showResults, followUp: followUp ?? "" });
		});
		return () => {
			isCurrent = false;
		};
	}, [pollId]);

	const setOption = (index, key, value) =>
		setPoll((current) => ({ ...current, options: current.options.map((option, at) => (at === index ? { ...option, [key]: value } : option)) }));

	function submit(event) {
		event.preventDefault();
		setError("");
		startTransition(async () => {
			const values = { ...poll, options: poll.options.map(({ label, tag }) => ({ label: label.trim(), tag: tag.trim() })) };
			const result = pollId ? await updatePoll(pollId, values) : await createPoll(newsletterId, campaignId, values);
			if (result?.error) return void setError(result.error);
			onSave({ id: result.poll.id, question: result.poll.question, options: result.poll.options.map(({ label }) => label) });
		});
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>{COPY.poll.title}</DialogTitle>
				<DialogDescription>{COPY.poll.description}</DialogDescription>
			</DialogHeader>
			<label className="flex flex-col gap-1.5 text-sm">
				Question
				<Input value={poll.question} onChange={(event) => setPoll({ ...poll, question: event.target.value })} maxLength={200} required autoFocus />
			</label>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1.5 text-sm">Answers, and a tag for who picks each (optional)</legend>
				{poll.options.map((option, index) => (
					<div key={index} className="flex gap-2">
						<Input value={option.label} onChange={(event) => setOption(index, "label", event.target.value)} placeholder={`Answer ${index + 1}`} aria-label={`Answer ${index + 1}`} maxLength={100} required />
						<Input value={option.tag} onChange={(event) => setOption(index, "tag", event.target.value)} placeholder="Tag" aria-label={`Tag for answer ${index + 1}`} maxLength={60} className="w-28" />
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={`Remove answer ${index + 1}`}
							disabled={poll.options.length <= 2}
							onClick={() => setPoll({ ...poll, options: poll.options.filter((_, at) => at !== index) })}
						>
							<X />
						</Button>
					</div>
				))}
				{poll.options.length < MAX_OPTIONS && (
					<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setPoll({ ...poll, options: [...poll.options, { label: "", tag: "" }] })}>
						<Plus data-icon="inline-start" />
						Add an answer
					</Button>
				)}
			</fieldset>
			{choices.length > 0 && (
				<label className="flex flex-col gap-1.5 text-sm">
					Save the answer in a custom field
					<select
						value={poll.fieldKey}
						onChange={(event) => setPoll({ ...poll, fieldKey: event.target.value })}
						className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
					>
						<option value="">No field</option>
						{choices.map(({ key, label }) => (
							<option key={key} value={key}>
								{label}
							</option>
						))}
					</select>
				</label>
			)}
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" checked={poll.showResults} onChange={(event) => setPoll({ ...poll, showResults: event.target.checked })} className="size-4 accent-foreground" />
				Show the results after voting
			</label>
			<label className="flex flex-col gap-1.5 text-sm">
				Follow-up question (optional)
				<Input value={poll.followUp} onChange={(event) => setPoll({ ...poll, followUp: event.target.value })} placeholder="Why did you pick that?" maxLength={200} />
			</label>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter>
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					{COPY.poll.save}
				</Button>
			</DialogFooter>
		</form>
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
