"use client";
import useReaderText from "@/components/useReaderText";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";
import { savePreferenceForm } from "@/app/preferences/actions";
import InputCustomField from "@/components/InputCustomField";
import { Button } from "@/components/ui/button";

// A reader's editable fields. fields: { key, label, type, options, multiple }; values: the contact's, by key.
export default function FormPreferences({ token, fields, values, lists = [], listIds = [] }) {
	const t = useReaderText();
	const [state, action, isPending] = useActionState(savePreferenceForm.bind(null, token), null);

	return (
		<form action={action} className="mt-6 flex flex-col gap-4 text-left">
			{lists.length > 0 && <fieldset className="flex flex-col gap-3"><legend className="mb-2 font-medium">{t("Email lists")}</legend><input type="hidden" name="lists_present" value="1" /><p className="text-xs text-muted-foreground">{t("Choose optional emails. General newsletter issues may still arrive. Unsubscribe below to stop all emails.")}</p>{lists.map((list) => <label key={list.id} className="flex items-start gap-2 text-sm"><input type="checkbox" name="lists" value={list.id} defaultChecked={listIds.includes(list.id)} className="mt-1" /><span>{list.name}{list.description && <span className="block text-xs text-muted-foreground">{list.description}</span>}</span></label>)}</fieldset>}
			{fields.map((field) => (
				<div key={field.key} className="flex flex-col gap-1.5 text-sm">
					<span className="font-medium text-foreground">{field.label}</span>
					<InputCustomField field={field} name={`field_${field.key}`} value={values[field.key]} />
				</div>
			))}
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{t.error(state.error)}
				</p>
			)}
			{state?.ok && (
				<p role="status" className="flex items-center gap-2 text-sm font-medium text-foreground">
					<Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
					{t("Saved")}
				</p>
			)}
			<Button type="submit" size="lg" disabled={isPending}>
				{isPending ? <Loader2 className="animate-spin" /> : t("Save")}
			</Button>
		</form>
	);
}
