import FormStripeSubscriberImport from "@/components/FormStripeSubscriberImport";
import Link from "next/link";
import CardComps from "@/components/CardComps";
import CardGifts from "@/components/CardGifts";
import CardOffers from "@/components/CardOffers";
import CardPaidTiers from "@/components/CardPaidTiers";
import CardPledges from "@/components/CardPledges";
import CardStripe from "@/components/CardStripe";
import FormPaidTier from "@/components/FormPaidTier";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getPaymentsState } from "@/lib/payments/connect";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Payments" };

const ERRORS = {
	connect: "Stripe's page couldn't be opened. Try again in a minute.",
	unavailable: "Stripe can't be reached right now. Try again in a minute.",
};

// Where the account is paid (Stripe), and the open newsletter's paid tier. Back from Stripe's onboarding
// (?connect=return) the status is asked again, since Stripe's own update can still be on its way.
export default async function PaymentsPage({ searchParams }) {
	const [{ connect, error }, { account, selected }] = await Promise.all([searchParams, getSelectedNewsletter()]);
	const [statusResult, tierResult, tiersResult, pledgeReport, pledgeCharging, offersResult, giftsResult, compsResult] = await Promise.all([
		runDashboardAction("get_payments_status", { refresh: connect === "return" }),
		selected ? runDashboardAction("get_paid_tier", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_paid_tiers", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("get_pledge_report", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("get_pledge_charging", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_offers", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_gifts", { id: String(selected._id), limit: 20 }) : null,
		selected ? runDashboardAction("list_comps", { id: String(selected._id) }) : null,
	]);
	const status = statusResult.output ?? { ...getPaymentsState(account), platformFeePercent: 0 };

	return (
		<LayoutNarrow>
			<HeaderPage title="Payments" />
			<div className="flex flex-col gap-6">
				{ERRORS[error] && (
					<p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive animate-enter">
						{ERRORS[error]}
					</p>
				)}
				<CardStripe status={status} />
				{selected && <section className="rounded-xl border p-5"><h2 className="font-semibold">Sponsorships</h2><p className="mt-2 text-sm text-muted-foreground">Sell direct placements, review creative and invoice sponsors through your own Stripe account.</p><Link className="mt-3 inline-block text-sm underline" href="/sponsorships">Manage sponsorships</Link></section>}
				{selected && <section className="rounded-xl border p-5"><h2 className="font-semibold">Reader billing</h2><p className="mt-2 text-sm text-muted-foreground">Enable pauses, select an existing save offer and read optional cancellation feedback.</p><Link className="mt-3 inline-block text-sm underline" href="/reader-billing">Manage reader billing</Link></section>}
				{selected && <section className="rounded-xl border p-5"><h2 className="font-semibold">Group subscriptions</h2><p className="mt-2 text-sm text-muted-foreground">One buyer pays per reader seat. Invitations require each reader’s acceptance.</p><Link className="mt-3 inline-block text-sm underline" href="/group-subscriptions">Manage groups</Link></section>}
				{selected && tiersResult?.output && <FormStripeSubscriberImport newsletterId={String(selected._id)} tiers={tiersResult.output.tiers} />}
				{selected && tierResult?.output && <FormPaidTier newsletter={{ id: String(selected._id), name: selected.name }} tier={tierResult.output} isReady={status.ready} />}
				{selected && tiersResult?.output && <CardPaidTiers newsletterId={String(selected._id)} tiers={tiersResult.output.tiers} />}
				{selected && pledgeReport?.output && (
					<CardPledges newsletterId={String(selected._id)} report={pledgeReport.output} charging={pledgeCharging?.output?.charging ?? null} isPaidOn={Boolean(tierResult?.output?.enabled)} />
				)}
				{selected && compsResult?.output && tiersResult?.output && <CardComps newsletterId={String(selected._id)} comps={compsResult.output.comps} tiers={tiersResult.output.tiers.filter((tier) => !tier.archived)} />}
				{selected && giftsResult?.output && <CardGifts newsletterId={String(selected._id)} data={giftsResult.output} />}
				{selected && offersResult?.output && <CardOffers newsletterId={String(selected._id)} data={offersResult.output} />}
			</div>
		</LayoutNarrow>
	);
}
