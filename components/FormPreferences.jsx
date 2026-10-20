"use client";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";
import { savePreferenceForm } from "@/app/preferences/actions";
import InputCustomField from "@/components/InputCustomField";
import { Button } from "@/components/ui/button";

// A reader's editable fields. fields: { key, label, type, options, multiple }; values: the contact's, by key.
export default function FormPreferences({ token, fields, values }) {
	const [state, action, isPending] = useActionState(savePreferenceForm.bind(null, token), null);

	return (
		<form action={action} className="mt-6 flex flex-col gap-4 text-left">
			{fields.map((field) => (
				<div key={field.key} className="flex flex-col gap-1.5 text-sm">
					<span className="font-medium text-foreground">{field.label}</span>
					<InputCustomField field={field} name={`field_${field.key}`} value={values[field.key]} />
				</div>
			))}
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			{state?.ok && (
				<p role="status" className="flex items-center gap-2 text-sm font-medium text-foreground">
					<Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
					Saved
				</p>
			)}
			<Button type="submit" size="lg" disabled={isPending}>
				{isPending ? <Loader2 className="animate-spin" /> : "Save"}
			</Button>
		</form>
	);
}
