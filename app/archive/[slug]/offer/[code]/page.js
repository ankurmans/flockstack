import { notFound } from "next/navigation";
import FormSubscribePaid from "@/components/FormSubscribePaid";
import { getArchiveNewsletter, getShopPayments } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getOfferProblem, describeOffer } from "@/lib/offer-rules";
import { countRedemptions, findOfferByCode } from "@/lib/offers";
import { formatPrice } from "@/lib/payments/config";
import { OPTION_LABELS, OPTION_NOTES, getNewsletterTiers, getOfferedTiers, getTierOptions } from "@/lib/tier-rules";

// An offer link is the subscribe page with a discount or a trial applied. It reads the offer on every visit, so an offer
// that ended or ran out says so the moment it does.
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

export default async function OfferPage({ params }) {
	const { slug, code } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter?.paidTier?.enabled) notFound();
	const offer = await findOfferByCode(newsletter, code);
	if (!offer) notFound();
	const [payments, redemptions] = await Promise.all([getShopPayments(newsletter), countRedemptions(newsletter.accountId, offer)]);
	const problem = getOfferProblem(offer, { redemptions }) ?? (offer.type === "amount" && offer.currency !== (newsletter.paidTier.currency || "usd") ? "This offer has ended" : null);
	const urls = getArchiveUrls(newsletter);
	const currency = newsletter.paidTier.currency || "usd";
	const tiers = getOfferedTiers(getNewsletterTiers(newsletter))
		.filter((tier) => !offer.tierIds?.length || offer.tierIds.includes(tier.id))
		.map((tier) => ({
			id: tier.id,
			name: tier.name,
			description: tier.description,
			benefits: tier.benefits,
			founding: { enabled: false, spotsLeft: null, canName: false },
			options: getTierOptions(tier).map(({ option, cents }) => ({ option, cents, label: OPTION_LABELS[option], note: option === "pwyw" ? (tier.pwyw.interval === "month" ? "a month or more" : "a year or more") : OPTION_NOTES[option] })),
		}));

	return (
		<div className="mx-auto max-w-xl px-5 pt-16 pb-24 sm:pt-20">
			<p className="text-sm font-medium text-muted-foreground animate-enter">{offer.name}</p>
			<h1 style={{ "--stagger": 1 }} className="mt-2 text-4xl font-semibold tracking-tight text-balance animate-enter">
				{problem ? problem : describeOffer(offer, formatPrice)}
			</h1>
			<p style={{ "--stagger": 2 }} className="mt-4 text-lg text-muted-foreground text-pretty animate-enter">
				{problem ? `You can still become a paid subscriber of ${newsletter.name} at its regular price.` : `Become a paid subscriber of ${newsletter.name}. The price below is what you pay, and Stripe shows it again at checkout.`}
			</p>
			<div style={{ "--stagger": 3 }} className="mt-10 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
				{payments.ready && tiers.length > 0 ? (
					<FormSubscribePaid
						newsletterSlug={newsletter.slug}
						tiers={tiers}
						currency={currency}
						trialDays={problem ? 0 : (offer.trialDays ?? newsletter.paidTier.trialDays ?? 0)}
						offer={problem ? null : { code: offer.code, type: offer.type, percentOff: offer.percentOff, amountOffCents: offer.amountOffCents }}
					/>
				) : (
					<p className="text-sm text-muted-foreground">Paid subscriptions aren&apos;t open right now. Check back soon.</p>
				)}
			</div>
			<p className="mt-6 text-sm text-muted-foreground">
				<a href={urls.subscribe} className="underline underline-offset-4 transition-colors duration-150 hover:text-foreground">
					See every plan
				</a>
			</p>
		</div>
	);
}
