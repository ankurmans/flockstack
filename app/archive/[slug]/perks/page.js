import { notFound, redirect } from "next/navigation";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { findSessionReader } from "@/lib/reader-session";
import { readerPerks } from "@/lib/perk-rules";
import { getReaderText } from "@/lib/reader-languages";
export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriber perks", robots: { index: false, follow: false } };
export default async function PerksPage({ params }) {
	const site = await getArchiveNewsletter((await params).slug); if (!site) notFound();
	const urls = getArchiveUrls(site); const contact = await findSessionReader(site); if (!contact) redirect(urls.signin);
	const newsletter = await findOpenNewsletter({ _id: site._id }); if (!newsletter) notFound();
	const perks = readerPerks(newsletter, contact); const t = getReaderText(newsletter);
	return <div className="mx-auto max-w-2xl px-5 py-16"><h1 className="text-3xl font-semibold">{t("Subscriber perks")}</h1><p className="mt-3 text-muted-foreground">{t("Perks available with your current paid subscription.")}</p>{perks.length === 0 && <p className="mt-8">{t("No perks are available for your current tier.")}</p>}<ul className="mt-8 flex flex-col gap-6">{perks.map((perk) => <li key={perk.id} className="rounded-xl border p-5"><h2 className="text-lg font-medium">{perk.title}</h2>{perk.description && <p className="mt-2 whitespace-pre-wrap">{perk.description}</p>}{perk.code && <p className="mt-3"><span className="text-sm text-muted-foreground">{t("Your code")}: </span><code className="break-all rounded bg-muted px-2 py-1">{perk.code}</code></p>}<div className="mt-4 flex gap-4">{perk.url && <a className="underline underline-offset-4" href={perk.url} rel="noreferrer noopener">{t("Use this perk")}</a>}{perk.productId && <a className="underline underline-offset-4" href={`/api/reader-perks/${site.slug}/${perk.id}`}>{t("Download")}</a>}</div></li>)}</ul><a href={urls.account} className="mt-8 inline-block underline underline-offset-4">{t("Your account")}</a></div>;
}
