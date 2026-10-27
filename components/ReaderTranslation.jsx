"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import useReaderText from "@/components/useReaderText";
import { READER_LANGUAGES } from "@/lib/reader-languages";
const LABELS = { en: "English", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano", pt: "Português" };
const ERRORS = {
	signin_required: "Sign in to translate this issue.", disabled: "Translation is not enabled for this newsletter.",
	too_long: "This issue is too long to translate here. The original is still available.", daily_limit: "This newsletter has used its translation allowance for today.",
	rate_limited: "Too many translation requests. Try again later.", issue_changed: "The issue changed. Reload it before translating.",
	unavailable: "Translation is unavailable. Try again later.", not_found: "This issue is unavailable.",
};
export default function ReaderTranslation({ slug, post, language, enabled, hasSession, children }) {
	const t = useReaderText(language);
	const [target, setTarget] = useState(language === "en" ? "es" : "en");
	const [answer, setAnswer] = useState(null);
	const [show, setShow] = useState(false);
	const [pending, start] = useTransition();
	if (!enabled || !hasSession) return children;
	function translate() {
		start(async () => {
			try {
				const response = await fetch("/api/reader-translation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, post, language: target }), cache: "no-store" });
				const result = await response.json();
				setAnswer({ ...result, language: target });
				setShow(result.status === "ready");
			} catch { setAnswer({ error: "unavailable" }); }
		});
	}
	return <>
		<div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
			<label className="sr-only" htmlFor={`translation-${post}`}>{t("Translation language")}</label>
			<select id={`translation-${post}`} className="h-9 rounded-md border bg-background px-2" value={target} disabled={pending} onChange={(event) => { setTarget(event.target.value); setAnswer(null); setShow(false); }}>{READER_LANGUAGES.map((code) => <option key={code} value={code}>{LABELS[code]}</option>)}</select>
			<Button type="button" size="sm" variant="outline" disabled={pending} onClick={translate}>{t(pending ? "Translating…" : "Translate this issue")}</Button>
			{answer?.status === "ready" && <Button type="button" size="sm" variant="ghost" onClick={() => setShow(!show)}>{t(show ? "Show original" : "Show translation")}</Button>}
			{answer?.error && <p role="alert" className="w-full text-muted-foreground">{t(ERRORS[answer.error] ?? ERRORS.unavailable)}</p>}
			{answer?.status === "pending" && <p role="status" className="w-full text-muted-foreground">{t("Another translation is in progress. Try again shortly.")}</p>}
		</div>
		{show && answer?.text ? <div lang={answer.language} className="mt-8"><p className="mb-4 text-xs text-muted-foreground">{t("Translated text. Check the original for exact wording.")}</p><div className="whitespace-pre-wrap break-words leading-relaxed">{answer.text}</div></div> : children}
	</>;
}
