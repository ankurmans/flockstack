"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { addContactTag, removeContactTag, setContactField } from "@/app/(app)/contacts/actions";
import BadgeTag from "@/components/BadgeTag";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import InputCustomField from "@/components/InputCustomField";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// One contact's tags and custom field values. Each change is saved as it's made.
export default function DialogContactDetails({ contact, definitions, isOpen, onOpenChange, tagColors = {} }) {
	const [tags, setTags] = useState(contact.tags);
	const [fields, setFields] = useState(contact.fields);
	const [newTag, setNewTag] = useState("");
	const [isPending, startTransition] = useTransition();

	function addTag(event) {
		event.preventDefault();
		if (!newTag.trim()) return;
		startTransition(async () => {
			const result = await addContactTag(contact.id, newTag);
			if (result?.error) return void toast.error(result.error);
			setTags(result.tags);
			setNewTag("");
		});
	}

	function removeTag(tag) {
		startTransition(async () => {
			const result = await removeContactTag(contact.id, tag);
			if (result?.error) return void toast.error(result.error);
			setTags(result.tags);
		});
	}

	function saveField(key, value) {
		const same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
		if (same(fields[key], typeof value === "string" ? value.trim() : value)) return;
		startTransition(async () => {
			const result = await setContactField(contact.id, key, value);
			if (result?.error) return void toast.error(result.error);
			setFields(result.fields);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Tags and fields</DialogTitle>
					<DialogDescription className="wrap-anywhere">{contact.email}</DialogDescription>
				</DialogHeader>

				<section className="flex flex-col gap-2.5">
					<h3 className="text-sm font-medium">Tags</h3>
					{tags.length > 0 && (
						<ul className="flex flex-wrap gap-1.5">
							{tags.map((tag) => (
								<li key={tag}>
									<BadgeTag name={tag} color={tagColors[tag]} className="h-6 pr-1 pl-2.5">
										<button
											type="button"
											onClick={() => removeTag(tag)}
											disabled={isPending}
											aria-label={`Remove ${tag}`}
											className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
										>
											<X className="size-3" />
										</button>
									</BadgeTag>
								</li>
							))}
						</ul>
					)}
					<form onSubmit={addTag} className="flex gap-2">
						<Input
							value={newTag}
							onChange={(event) => setNewTag(event.target.value)}
							placeholder="Add a tag"
							aria-label="Add a tag"
							maxLength={60}
							className="h-9"
						/>
						<Button type="submit" variant="outline" disabled={isPending || !newTag.trim()}>
							{isPending ? <Loader2 className="animate-spin" /> : <Plus data-icon="inline-start" />}
							Add
						</Button>
					</form>
				</section>

				<section className="flex flex-col gap-2.5">
					<h3 className="text-sm font-medium">Custom fields</h3>
					{definitions.length === 0 ? (
						<p className="text-sm text-muted-foreground">This newsletter has no custom fields yet. Add them from Tags and fields on the contacts page.</p>
					) : (
						definitions.map((field) => (
							<div key={field.key} className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">{field.label}</span>
								<InputCustomField field={field} name={`field_${field.key}`} value={fields[field.key]} onCommit={(value) => saveField(field.key, value)} />
							</div>
						))
					)}
				</section>
			</DialogContent>
		</Dialog>
	);
}
