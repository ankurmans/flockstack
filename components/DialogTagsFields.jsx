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
import { toast } from "@/lib/toast";

const TYPE_LABELS = { text: "Text", number: "Number", date: "Date" };

// The open newsletter's custom fields (for merge tags, segments and automations) and its tags.
export default function DialogTagsFields({ newsletter, definitions, tags }) {
	const router = useRouter();
	const [label, setLabel] = useState("");
	const [type, setType] = useState("text");
	const [onSignupForm, setOnSignupForm] = useState(false);
	const [isPending, startTransition] = useTransition();

	function run(action, message) {
		startTransition(async () => {
			const result = await action();
			if (result?.error) return void toast.error(result.error);
			if (message) toast.success(message);
			router.refresh();
		});
	}

	function addField(event) {
		event.preventDefault();
		run(async () => {
			const result = await createCustomField({ newsletterId: newsletter.id, label, type, onSignupForm });
			if (!result?.error) {
				setLabel("");
				setOnSignupForm(false);
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
											{TYPE_LABELS[field.type]} · <code>{`{{${field.key}}}`}</code>
										</p>
									</div>
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
										onClick={() => run(() => deleteCustomField({ newsletterId: newsletter.id, key: field.key }), "Field deleted")}
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
							<SelectTrigger className="h-9 w-full sm:w-28" aria-label="Type">
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
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={onSignupForm}
							onChange={(event) => setOnSignupForm(event.target.checked)}
							className="size-4 accent-foreground"
						/>
						Ask for it on the signup form
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
										onClick={() => run(() => deleteTag(newsletter.id, tag), `Tag ${tag} deleted`)}
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
