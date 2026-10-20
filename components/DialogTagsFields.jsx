"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Tags, Trash2 } from "lucide-react";
import { createCustomField, deleteCustomField, deleteTag, updateCustomField } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCount } from "@/lib/format";
import { toast } from "@/lib/toast";

const TYPE_LABELS = { text: "Text", number: "Number", date: "Date", datetime: "Date and time", boolean: "Yes or no", list: "List" };

// The open newsletter's custom fields (for merge tags, segments and automations) and its tags.
export default function DialogTagsFields({ newsletter, definitions, tags }) {
	const router = useRouter();
	const [label, setLabel] = useState("");
	const [type, setType] = useState("text");
	const [options, setOptions] = useState("");
	const [multiple, setMultiple] = useState(false);
	const [onSignupForm, setOnSignupForm] = useState(false);
	const [readerEditable, setReaderEditable] = useState(false);
	const [isPending, startTransition] = useTransition();

	// message: a string, or what to say from the action's answer. A large list loses a tag or a field in the background,
	// and the contacts page shows how far it got.
	function run(action, message) {
		startTransition(async () => {
			const result = await action();
			if (result?.error) return void toast.error(result.error);
			const text = typeof message === "function" ? message(result) : message;
			if (text) toast.success(text);
			router.refresh();
		});
	}

	function addField(event) {
		event.preventDefault();
		run(async () => {
			const choices = options.split("\n").map((option) => option.trim()).filter(Boolean);
			const result = await createCustomField({ newsletterId: newsletter.id, label, type, options: choices, multiple, onSignupForm, readerEditable });
			if (!result?.error) {
				setLabel("");
				setOptions("");
				setMultiple(false);
				setOnSignupForm(false);
				setReaderEditable(false);
			}
			return result;
		});
	}

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline" disabled={!newsletter}>
					<Tags data-icon="inline-start" />
					Tags and fields
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Tags and fields</DialogTitle>
					<DialogDescription>
						Custom fields hold a value for each contact. Use one in an email as a merge tag, like {"{{first_name|there}}"}, and in
						segments and automations.
					</DialogDescription>
				</DialogHeader>

				<section className="flex flex-col gap-3">
					<h3 className="text-sm font-medium">Custom fields</h3>
					{definitions.length > 0 && (
						<ul className="divide-y divide-border/60 rounded-xl shadow-border">
							{definitions.map((field) => (
								<li key={field.key} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium">{field.label}</p>
										<p className="truncate text-xs text-muted-foreground">
											{TYPE_LABELS[field.type]}
											{field.type === "list" && `${field.multiple ? ", several" : ""}: ${field.options.join(", ")}`} · <code>{`{{${field.key}}}`}</code>
										</p>
									</div>
									<label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
										<input
											type="checkbox"
											checked={field.readerEditable}
											disabled={isPending}
											onChange={(event) =>
												run(() => updateCustomField({ newsletterId: newsletter.id, key: field.key, readerEditable: event.target.checked }))
											}
											className="size-3.5 accent-foreground"
										/>
										Readers edit
									</label>
									<label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
										<input
											type="checkbox"
											checked={field.onSignupForm}
											disabled={isPending}
											onChange={(event) =>
												run(() => updateCustomField({ newsletterId: newsletter.id, key: field.key, onSignupForm: event.target.checked }))
											}
											className="size-3.5 accent-foreground"
										/>
										On signup form
									</label>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Delete ${field.label}`}
										disabled={isPending}
										onClick={() =>
											run(
												() => deleteCustomField({ newsletterId: newsletter.id, key: field.key }),
												(result) => (result.inBackground ? `Field deleted. Removing it from ${formatCount(result.contacts, "contact")}…` : "Field deleted")
											)
										}
										className="text-muted-foreground hover:text-destructive"
									>
										<Trash2 />
									</Button>
								</li>
							))}
						</ul>
					)}
					<form onSubmit={addField} className="flex flex-col gap-2.5 sm:flex-row">
						<Input
							value={label}
							onChange={(event) => setLabel(event.target.value)}
							placeholder="New field, e.g. First name"
							aria-label="Field name"
							maxLength={40}
							required
							className="h-9"
						/>
						<Select value={type} onValueChange={setType}>
							<SelectTrigger className="h-9 w-full sm:w-36" aria-label="Type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(TYPE_LABELS).map(([value, name]) => (
									<SelectItem key={value} value={value}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button type="submit" variant="outline" disabled={isPending || !label.trim()}>
							{isPending ? <Loader2 className="animate-spin" /> : <Plus data-icon="inline-start" />}
							Add
						</Button>
					</form>
					{type === "list" && (
						<>
							<textarea
								value={options}
								onChange={(event) => setOptions(event.target.value)}
								placeholder={"Options, one a line\nWeekly digest\nProduct news"}
								aria-label="Options, one a line"
								rows={3}
								className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
							/>
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} className="size-4 accent-foreground" />
								Contacts can pick several
							</label>
						</>
					)}
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={onSignupForm}
							onChange={(event) => setOnSignupForm(event.target.checked)}
							className="size-4 accent-foreground"
						/>
						Ask for it on the signup form
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={readerEditable}
							onChange={(event) => setReaderEditable(event.target.checked)}
							className="size-4 accent-foreground"
						/>
						Readers can change it on their preferences page
					</label>
				</section>

				<section className="flex flex-col gap-3">
					<h3 className="text-sm font-medium">Tags</h3>
					{tags.length === 0 ? (
						<p className="text-sm text-muted-foreground">No tags yet. Add them to a contact from its menu, with an import or the API.</p>
					) : (
						<ul className="flex flex-wrap gap-1.5">
							{tags.map((tag) => (
								<li key={tag} className="inline-flex h-6 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs">
									{tag}
									<button
										type="button"
										disabled={isPending}
										onClick={() =>
											run(
												() => deleteTag(newsletter.id, tag),
												(result) =>
													result.inBackground ? `Removing the tag ${tag} from ${formatCount(result.contacts, "contact")}…` : `Tag ${tag} deleted`
											)
										}
										aria-label={`Delete the tag ${tag}`}
										className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-destructive"
									>
										<Trash2 className="size-3" />
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			</DialogContent>
		</Dialog>
	);
}
