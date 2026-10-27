"use client";
import { getReaderText } from "@/lib/reader-languages";
import Image from "next/image";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";

export default function FormSponsorshipAction({ action: serverAction, label, children, language = "en" }) {
	const t = getReaderText(language);
	const [state, action, pending] = useActionState(serverAction, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3">{children}<Button type="submit" variant="outline" disabled={pending} className="self-start">{pending ? t("Working…") : label}</Button>{state?.error && <p role="alert" className="text-sm text-destructive">{t.error(state.error)}</p>}{state?.ok && <p role="status" className="text-sm">{t(state.message ?? "Saved")}</p>}{state?.url && <a href={state.url} rel="noreferrer" className="text-sm underline">{t("Review invoice in Stripe")}</a>}{state?.dataUrl && <Image src={state.dataUrl} width={600} height={400} unoptimized alt={t("Private sponsor preview")} className="max-h-80 w-auto object-contain" />}</form>;
}
