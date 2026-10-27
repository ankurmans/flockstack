"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { getReaderText } from "@/lib/reader-languages";

export default function FormGroupAction({ action: serverAction, label, children, variant = "outline", language = "en" }) {
	const t = getReaderText(language);
	const [state, action, pending] = useActionState(serverAction, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3">
		{children}
		<Button type="submit" variant={variant} disabled={pending} className="self-start">{pending ? t("Working…") : label}</Button>
		{state?.error && <p role="alert" className="text-sm text-destructive">{t.error(state.error)}</p>}
		{state?.ok && <p role="status" className="text-sm">{t(state.message ?? "Saved")}</p>}
		{state?.checkoutUrl && <a href={state.checkoutUrl} className="text-sm underline" rel="noreferrer">{t("Open Stripe checkout")}</a>}
		{state?.billingUrl && <a href={state.billingUrl} className="text-sm underline" rel="noreferrer">{t("Manage billing in Stripe")}</a>}
		{state?.continueUrl && <a href={state.continueUrl} className="text-sm underline">{t("Read past issues")}</a>}
	</form>;
}
