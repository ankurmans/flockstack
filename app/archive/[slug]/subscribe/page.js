import { notFound } from "next/navigation";
import FormSubscribePaid from "@/components/FormSubscribePaid";
import NoticePaid from "@/components/NoticePaid";
import { getArchiveNewsletter, getShopPayments } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getShopMetadata } from "@/lib/archive-seo";
import { OPTION_LABELS, OPTION_NOTES, getNewsletterTiers, getOfferedTiers, getTierOptions } from "@/lib/tier-rules";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter?.paidTier?.enabled) return {};
	return getShopMetadata(newsletter, {
		title: `Become a paid subscriber · ${newsletter.name}`,
		description: `Get every issue of ${newsletter.name}, including the paid ones.`,
		url: getArchiveUrls(newsletter).absoluteSubscribe,
	});
}

export default async function SubscribePage({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter?.paidTier?.enabled) notFound();
	const payments = await getShopPayments(newsletter);
	const { currency = "usd", trialDays = 0, pitch } = newsletter.paidTier;
	const urls = getArchiveUrls(newsletter);
	const tiers = getOfferedTiers(getNewsletterTiers(newsletter)).map((tier) => ({
		id: tier.id,
		name: tier.name,
		description: tier.description,
		benefits: tier.benefits,
		founding: { enabled: tier.founding.enabled, spotsLeft: null },
		options: getTierOptions(tier).map(({ option, cents }) => ({ option, cents, label: OPTION_LABELS[option], note: option === "pwyw" ? (tier.pwyw.interval === "month" ? "a month or more" : "a year or more") : OPTION_NOTES[option] })),
	}));

	return (
		<div className="mx-auto max-w-xl px-5 pt-16 pb-24 sm:pt-20">
			<NoticePaid>Thanks for subscribing. Your first paid issue lands in your inbox; if you don&apos;t see a welcome email, check the spam folder.</NoticePaid>
			<h1 className="text-4xl font-semibold tracking-tight text-balance animate-enter">Become a paid subscriber</h1>
			<p style={{ "--stagger": 1 }} className="mt-4 text-lg text-muted-foreground text-pretty animate-enter">
				{pitch || `Get every issue of ${newsletter.name}, including the ones for paid subscribers only.`}
			</p>
			<div style={{ "--stagger": 2 }} className="mt-10 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
				{payments.ready && tiers.length > 0 ? (
					<FormSubscribePaid newsletterSlug={newsletter.slug} tiers={tiers} currency={currency} trialDays={trialDays} />
				) : (
					<p className="text-sm text-muted-foreground">Paid subscriptions aren&apos;t open right now. Check back soon.</p>
				)}
			</div>
			<p className="mt-6 text-sm text-muted-foreground">
				Just want the free issues?{" "}
				<a href={`${urls.index}#subscribe`} className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
					Subscribe for free
				</a>
				.
			</p>
		</div>
	);
}
