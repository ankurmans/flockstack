import ProviderReaderLanguage from "@/components/ProviderReaderLanguage";
import { getReaderText } from "@/lib/reader-languages";
import { Link2Off, SlidersHorizontal } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import FormPreferences from "@/components/FormPreferences";
import { openPreferences } from "@/lib/preferences";
import { createUnsubscribeToken } from "@/lib/unsubscribe";

// The URL carries the reader's token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Your preferences",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

// What a subscriber can change about their subscription, from the link in an email's footer.
export default async function PreferencesPage({ searchParams }) {
	const { token } = await searchParams;
	const validToken = typeof token === "string" ? token : null;
	const open = validToken ? await openPreferences(validToken).catch(() => null) : null;
	if (!open) {
		return (
			<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
				<CardNotice icon={Link2Off} title="This link doesn't work">
					Open the preferences link from one of the newsletter&apos;s emails again.
				</CardNotice>
			</main>
		);
	}
	const { newsletter, contact, fields, lists } = open;
	const t = getReaderText(newsletter);
	const unsubscribe = `/unsubscribe?token=${createUnsubscribeToken({ contactId: contact._id, newsletterId: newsletter._id })}`;

	return (
		<ProviderReaderLanguage language={newsletter.language ?? "en"}><main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			<div className="w-full max-w-sm rounded-xl bg-card p-6 text-center shadow-border animate-enter sm:p-8">
				<div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<SlidersHorizontal className="size-5" aria-hidden="true" />
				</div>
				<h1 className="mt-4 text-lg font-semibold tracking-tight text-balance">{t("Your preferences for {name}", { name: newsletter.name })}</h1>
				<p className="mt-1.5 text-sm text-pretty text-muted-foreground wrap-anywhere">{contact.email}</p>
				{(fields.length > 0 || lists.length > 0) ? (
					<FormPreferences
						token={validToken}
						lists={lists} listIds={contact.listIds ?? []}
						fields={fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }))}
						values={contact.fields ?? {}}
					/>
				) : (
					<p className="mt-6 text-sm text-pretty text-muted-foreground">{t("There is nothing to set here. You can leave the newsletter below.")}</p>
				)}
				<a href={unsubscribe} className="mt-6 inline-block text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
					{t("Unsubscribe from {name}", { name: newsletter.name })}
				</a>
			</div>
		</main></ProviderReaderLanguage>
	);
}
