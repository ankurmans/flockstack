import { getReaderText } from "@/lib/reader-languages";
import { notFound, redirect } from "next/navigation";
import ButtonCopy from "@/components/ButtonCopy";
import FormPreferences from "@/components/FormPreferences";
import FormSupporterBadge from "@/components/FormSupporterBadge";
import FormReaderName from "@/components/FormReaderName";
import { Button } from "@/components/ui/button";
import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getReaderMetadata } from "@/lib/archive-seo";
import { signOutOfAccount } from "@/app/archive/reader-actions";
import { formatReaderBillingDate, readerBillingSummary, readerPledgeSummary, readerReferralSummary } from "@/lib/reader-billing-copy";
import { findNewsletterAnywhere } from "@/lib/public-newsletters";
import { findSessionReader } from "@/lib/reader-session";
import { getSubscriberCenter } from "@/lib/subscriber-center";

// Whose page it is comes from the session cookie, so it is built for each request and never cached.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	return newsletter ? getReaderMetadata(newsletter, "Your account") : {};
}

// The Subscriber Center: a signed-in reader's own page. Without a session, the sign-in page.
export default async function AccountPage({ params }) {
	const site = await getArchiveNewsletter((await params).slug);
	if (!site) notFound();
	const urls = getArchiveUrls(site);
	const reader = await findSessionReader(site);
	if (!reader) redirect(urls.signin);
	// The full newsletter: the referral program's settings aren't in the cached site data.
	const newsletter = await findNewsletterAnywhere({ _id: site._id });
	const center = await getSubscriberCenter({ newsletter, contact: reader });
	const { subscription } = center;
	const t = getReaderText(newsletter);
	const paid = readerBillingSummary(newsletter, subscription);

	return (
		<div className="mx-auto max-w-2xl px-5 pt-12 pb-24 sm:pt-16">
			<h1 className="text-3xl font-semibold tracking-tight text-balance animate-enter">{t("Your account")}</h1>
			<p style={{ "--stagger": 1 }} className="mt-2 text-muted-foreground wrap-anywhere animate-enter">
				{center.email}
			</p>

			<div className="mt-8 flex flex-col gap-4">
				<Card title={t("Profile")} stagger={2}>
					<dl className="grid gap-1 text-sm">
						<dt className="text-muted-foreground">{t("Email")}</dt>
						<dd className="font-medium wrap-anywhere">{center.email}</dd>
						{center.subscribedAt && (
							<>
								<dt className="mt-3 text-muted-foreground">{t("Subscribed since")}</dt>
								<dd className="font-medium">{formatReaderBillingDate(newsletter, center.subscribedAt)}</dd>
							</>
						)}
					</dl>
					{center.name && (
						<div className="mt-5">
							<FormReaderName slug={site.slug} name={center.name} />
						</div>
					)}
					{(center.supporterBadge.eligible || center.supporterBadge.enabled) && <FormSupporterBadge slug={site.slug} {...center.supporterBadge} />}
				</Card>

				<Card title={t("Subscription")} stagger={3}>
					{subscription.isPaid && (newsletter.perks ?? []).some((perk) => !perk.archived) && <a href={urls.perks} className="mb-4 inline-block underline underline-offset-4">{t("Subscriber perks")}</a>}
					{subscription.isPaid ? (
						<>
							<p className="font-medium">{paid.heading}</p>
							<p className="mt-1 text-sm text-muted-foreground">{paid.detail}</p>
						</>
					) : (
						<>
							<p className="font-medium">{t("Free subscriber")}</p>
							<p className="mt-1 text-sm text-muted-foreground">{t("You get the free issues by email and on the website.")}</p>
							{center.pledge && (
								<p className="mt-3 text-sm text-pretty">
									{readerPledgeSummary(newsletter, center.pledge)}{" "}
									<a href={center.pledge.cancelUrl} className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
										{t("Cancel your pledge")}
									</a>
								</p>
							)}
						</>
					)}
					<div className="mt-4 flex flex-wrap gap-2">
						{subscription.manageUrl && (
							<Button asChild variant="outline">
								<a href={subscription.manageUrl}>{t("Manage your subscription")}</a>
							</Button>
						)}
						{subscription.upgradeUrl && (
							<Button asChild>
								<a href={subscription.upgradeUrl}>{t(center.pledge ? "See the plans" : "Become a paid subscriber")}</a>
							</Button>
						)}
					</div>
				</Card>

				{(center.preferences.fields.length > 0 || center.preferences.lists.length > 0) && (
					<Card title={t("Preferences")} stagger={4}>
						<FormPreferences token={center.preferences.token} fields={center.preferences.fields} lists={center.preferences.lists} listIds={center.preferences.listIds} values={reader.fields ?? {}} />
					</Card>
				)}

				{center.referral && (
					<Card title={t("Refer a friend")} stagger={5}>
						<p className="text-sm text-pretty text-muted-foreground">
							{readerReferralSummary(newsletter, center.referral)}
						</p>
						<div className="mt-3 flex items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3">
							<input readOnly value={center.referral.link} aria-label={t("Your referral link")} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
							<ButtonCopy value={center.referral.link} label={t("Copy your referral link")} copiedLabel={t("Copied")} />
						</div>
						<a href={center.referral.pageUrl} className="mt-3 inline-block text-sm underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
							{t("See your rewards")}
						</a>
					</Card>
				)}

				<Card title={t("Leave")} stagger={6}>
					<div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
						<form action={signOutOfAccount}>
							<input type="hidden" name="newsletter" value={site.slug} />
							<Button type="submit" variant="outline">
								{t("Sign out")}
							</Button>
						</form>
						<a href={center.unsubscribeUrl} className="text-muted-foreground underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
							{t("Unsubscribe from {name}", { name: site.name })}
						</a>
					</div>
				</Card>
			</div>
		</div>
	);
}

function Card({ title, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
			<h2 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}
