import { headers } from "next/headers";
import PanelReaderBilling from "@/components/PanelReaderBilling";
import { readReaderBillingAccess, limitReaderBilling } from "@/lib/reader-billing-access";
import { readerRetentionOutput } from "@/lib/reader-retention-output";
import { readCurrentReaderBilling } from "@/lib/reader-retention-store";
import { getClientIp } from "@/lib/rate-limit";
import { getReaderText } from "@/lib/reader-languages";
import { toActionError } from "@/lib/actions/errors";
import { changeReaderBilling } from "./actions.js";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage your subscription", robots: { index: false, follow: false } };
export default async function ReaderBillingPage({ searchParams }) {
	const query = await searchParams, token = typeof query.token === "string" ? query.token : "";
	let context, initial, error;
	try { context = await readReaderBillingAccess(token); } catch (failure) { return <main className="mx-auto max-w-xl p-6"><p role="alert">{toActionError(failure).message}</p></main>; }
	const t = getReaderText(context.newsletter);
	try { await limitReaderBilling(context, getClientIp(await headers())); initial = await readerRetentionOutput(await readCurrentReaderBilling(context)); } catch (failure) { error = toActionError(failure).message; }
	return <main lang={t.language} className="mx-auto max-w-xl space-y-6 p-6"><h1 className="text-2xl font-semibold">{t("Manage your subscription")}</h1><p>{context.newsletter.name}</p>{error && <p role="alert">{t.error(error)}</p>}<PanelReaderBilling initial={initial ?? null} action={changeReaderBilling} token={token} language={t.language} /></main>;
}
