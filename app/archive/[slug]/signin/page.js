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

	return (
		<div className="mx-auto max-w-md px-5 pt-16 pb-24 sm:pt-24">
			<h1 className="text-3xl font-semibold tracking-tight text-balance animate-enter">Sign in to {newsletter.name}</h1>
			<p style={{ "--stagger": 1 }} className="mt-3 text-muted-foreground text-pretty animate-enter">
				We email you a link, so there is no password to remember. Paid subscribers read every issue here once they are signed in, and
				every subscriber can manage their subscription from their account page.
			</p>
			<div style={{ "--stagger": 2 }} className="relative mt-8 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
				<FormSiteSignin slug={newsletter.slug} />
			</div>
			<p className="mt-6 text-sm text-muted-foreground">
				Not subscribed yet? Subscribe from the form on the{" "}
				<a href={`${getArchiveUrls(newsletter).siteIndex}#subscribe`} className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
					home page
				</a>
				.
			</p>
		</div>
	);
}
