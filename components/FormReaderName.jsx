"use client";
import useReaderText from "@/components/useReaderText";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";
import { saveProfile } from "@/app/archive/reader-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The reader's name, on the Subscriber Center. The email is the subscription itself, so it only shows.
export default function FormReaderName({ slug, name }) {
	const t = useReaderText();
	const [state, action, isPending] = useActionState(saveProfile, null);

	return (
		<form action={action} className="flex flex-col gap-2">
			<input type="hidden" name="newsletter" value={slug} />
			<label htmlFor="reader-name" className="text-sm font-medium">
				{name.label}
			</label>
			<div className="flex gap-2">
				<Input id="reader-name" name="name" defaultValue={name.value} maxLength={100} autoComplete="given-name" className="h-10 min-w-0 flex-1" />
				<Button type="submit" variant="outline" disabled={isPending} className="h-10">
					{isPending ? <Loader2 className="animate-spin" /> : t("Save")}
				</Button>
			</div>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{t.error(state.error)}
				</p>
			)}
			{state?.ok && (
				<p role="status" className="flex items-center gap-2 text-sm font-medium">
					<Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
					{t("Saved")}
				</p>
			)}
		</form>
	);
}
