"use client";

import { useActionState } from "react";
import { saveCommentBadge } from "@/app/archive/reader-actions";
import { Button } from "@/components/ui/button";
import useReaderText from "@/components/useReaderText";

export default function FormSupporterBadge({ slug, enabled, eligible }) {
	const t = useReaderText();
	const [state, action, busy] = useActionState(saveCommentBadge, null);
	return <form action={action} className="mt-5 flex flex-col gap-2 border-t border-border/60 pt-4">
		<input type="hidden" name="newsletter" value={slug} />
		<label className="flex items-start gap-2 text-sm"><input type="checkbox" name="supporterBadge" defaultChecked={enabled} disabled={busy || (!eligible && !enabled)} className="mt-1" />{t("Show a supporter badge beside my comments")}</label>
		<p className="text-xs text-muted-foreground">{t("Visible to anyone reading your comments while your supporter membership is active. You can turn it off here.")}</p>
		<Button type="submit" size="sm" variant="outline" disabled={busy} className="w-fit">{t("Save")}</Button>
		{state?.error && <p role="alert" className="text-sm text-destructive">{t.error(state.error)}</p>}
		{state?.ok && <p role="status" className="text-sm">{t("Saved")}</p>}
	</form>;
}
