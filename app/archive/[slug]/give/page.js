import { notFound } from "next/navigation";
import FormGift from "@/components/FormGift";
import { getArchiveNewsletter, getShopPayments } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getShopMetadata } from "@/lib/archive-seo";
import { GIFT_REDEEM_MONTHS, getGiftOptions } from "@/lib/gift-rules";
import { areGiftsOpen } from "@/lib/gifts";
import { getNewsletterTiers } from "@/lib/tier-rules";

export const revalidate = 3600;

export function generateStaticParams() {
	return [];
}

export async function generateMetadata({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!areGiftsOpen(newsletter)) return {};
	return getShopMetadata(newsletter, {
		title: `Give a gift subscription · ${newsletter.name}`,
		description: `Give someone ${newsletter.name}, with every paid issue.`,
		url: getArchiveUrls(newsletter).absoluteGive,
	});
}

export default async function GivePage({ params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!areGiftsOpen(newsletter)) notFound();
	const payments = await getShopPayments(newsletter);
	const urls = getArchiveUrls(newsletter);
	const tiers = getNewsletterTiers(newsletter)
		.filter((tier) => !tier.archived)
		.map((tier) => ({ id: tier.id, name: tier.name, options: getGiftOptions(tier) }))
		.filter((tier) => tier.options.length > 0);
	// A page cached for an hour offers a day that may have passed by the time it is read, so the form's server side checks the day again.
	const today = new Date().toISOString().slice(0, 10);

	return (
		<div className="mx-auto max-w-xl px-5 pt-16 pb-24 sm:pt-20">
			<h1 className="text-4xl font-semibold tracking-tight text-balance animate-enter">Give a gift subscription</h1>
			<p style={{ "--stagger": 1 }} className="mt-4 text-lg text-muted-foreground text-pretty animate-enter">
				Give someone every issue of {newsletter.name}, the paid ones included, for as many months as you choose.
			</p>
			<div style={{ "--stagger": 2 }} className="mt-10 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
				{payments.ready && tiers.length > 0 ? (
					<FormGift newsletterSlug={newsletter.slug} tiers={tiers} currency={newsletter.paidTier.currency || "usd"} today={today} expiryMonths={GIFT_REDEEM_MONTHS} />
				) : (
					<p className="text-sm text-muted-foreground">Gifts aren&apos;t open right now. Check back soon.</p>
				)}
			</div>
			<p className="mt-6 text-sm text-muted-foreground">
				<a href={urls.subscribe} className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
					Subscribe for yourself instead
				</a>
			</p>
		</div>
	);
}
