"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getReaderText } from "@/lib/reader-languages";

export default function PanelGroupInvoices({ load, openBilling, language = "en" }) {
	const t = getReaderText(language);
	const amount = (value, currency) => value === null || !currency ? t("Unknown") : t("{amount} {currency} minor units", { amount: value, currency: currency.toUpperCase() });
	const [data, setData] = useState(null), [error, setError] = useState(null), [pending, start] = useTransition();
	function read(after) { start(async () => { const result = await load(after); if (result.error) setError(result.error); else { setError(null); setData(previous => ({ ...result, invoices: after ? [...(previous?.invoices ?? []), ...result.invoices] : result.invoices })); } }); }
	return <section className="flex flex-col gap-4 rounded-xl border p-5"><h2 className="font-semibold">{t("Invoices and billing")}</h2>
		<p className="text-sm text-muted-foreground">{t("Reads actual Stripe invoices for this group. Amounts are in the currency's smallest unit. Missing values stay unknown. Stripe manages card updates and cancellation at period end.")}</p>
		<div className="flex gap-3"><Button variant="outline" disabled={pending} onClick={() => read()}>{t("Load invoices")}</Button><Button variant="outline" disabled={pending} onClick={() => start(async () => { const result = await openBilling(); if (result.error) setError(result.error); else window.location.assign(result.url); })}>{t("Manage billing in Stripe")}</Button></div>
		{error && <p role="alert" className="text-sm text-destructive">{t.error(error)}</p>}
		{data && <ul className="divide-y">{data.invoices.length === 0 && <li className="py-3 text-sm">{t("No invoices returned.")}</li>}{data.invoices.map(invoice => <li key={invoice.id} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><div><p>{invoice.number ?? invoice.id} · {invoice.status ?? t("Unknown")}</p><p className="text-muted-foreground">{t("Total: {total}. Paid: {paid}.", { total: amount(invoice.totalMinor, invoice.currency), paid: amount(invoice.amountPaidMinor, invoice.currency) })}</p></div><div className="flex gap-3">{invoice.hostedUrl && <a className="underline" href={invoice.hostedUrl} target="_blank" rel="noreferrer">{t("Invoice")}</a>}{invoice.pdfUrl && <a className="underline" href={invoice.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}</div></li>)}</ul>}
		{data?.nextCursor && <Button variant="outline" disabled={pending} onClick={() => read(data.nextCursor)}>{t("More invoices")}</Button>}
	</section>;
}
