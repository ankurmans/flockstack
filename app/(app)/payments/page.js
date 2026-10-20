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
	const [statusResult, tierResult, tiersResult, pledgeReport, pledgeCharging, offersResult, giftsResult] = await Promise.all([
		runDashboardAction("get_payments_status", { refresh: connect === "return" }),
		selected ? runDashboardAction("get_paid_tier", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_paid_tiers", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("get_pledge_report", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("get_pledge_charging", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_offers", { id: String(selected._id) }) : null,
		selected ? runDashboardAction("list_gifts", { id: String(selected._id), limit: 20 }) : null,
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
				{selected && tierResult?.output && <FormPaidTier newsletter={{ id: String(selected._id), name: selected.name }} tier={tierResult.output} isReady={status.ready} />}
				{selected && tiersResult?.output && <CardPaidTiers newsletterId={String(selected._id)} tiers={tiersResult.output.tiers} />}
				{selected && pledgeReport?.output && (
					<CardPledges newsletterId={String(selected._id)} report={pledgeReport.output} charging={pledgeCharging?.output?.charging ?? null} isPaidOn={Boolean(tierResult?.output?.enabled)} />
				)}
				{selected && giftsResult?.output && <CardGifts newsletterId={String(selected._id)} data={giftsResult.output} />}
				{selected && offersResult?.output && <CardOffers newsletterId={String(selected._id)} data={offersResult.output} />}
			</div>
		</LayoutNarrow>
	);
}
