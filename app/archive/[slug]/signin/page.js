import { getReaderText } from "@/lib/reader-languages";
import { notFound } from "next/navigation";
import FormSiteSignin from "@/components/FormSiteSignin";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getReaderMetadata } from "@/lib/archive-seo";

// Cached for everyone: it only holds a form, whose answer is the same for every address.
export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	return newsletter ? getReaderMetadata(newsletter, "Sign in") : {};
}

export default async function SignInPage({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();
	const t = getReaderText(newsletter);

	return (
		<div className="mx-auto max-w-md px-5 pt-16 pb-24 sm:pt-24">
			<h1 className="text-3xl font-semibold tracking-tight text-balance animate-enter">{t("Sign in to {name}", { name: newsletter.name })}</h1>
			<p style={{ "--stagger": 1 }} className="mt-3 text-muted-foreground text-pretty animate-enter">
				{t("We email you a sign-in link. No password needed.")}
			</p>
			<div style={{ "--stagger": 2 }} className="relative mt-8 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
				<FormSiteSignin slug={newsletter.slug} />
			</div>
			<p className="mt-6 text-sm text-muted-foreground">
				<a href={`${getArchiveUrls(newsletter).siteIndex}#subscribe`} className="underline">{t("Sign up on the home page.")}</a>
			</p>
		</div>
	);
}
