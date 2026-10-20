import Link from "next/link";
import { CalendarDays, List, Send } from "lucide-react";
import BarBulkCampaigns from "@/components/BarBulkCampaigns";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import ProviderCampaignSelection from "@/components/ProviderCampaignSelection";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import { Button } from "@/components/ui/button";
import { getIssuePageUrl } from "@/lib/archive-data";
import { listNewsletterCampaigns } from "@/lib/campaign-queries";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
	const { account, selected, newsletters } = await getSelectedNewsletter();
	const campaigns = selected ? await listNewsletterCampaigns(account, selected._id, 200) : [];
	const pageUrls = Object.fromEntries(
		campaigns
			.map((campaign) => [campaign._id.toString(), getIssuePageUrl({ campaign, newsletter: selected })])
			.filter(([, url]) => url)
	);

	return (
		<>
			<HeaderPage title="Campaigns">
				<div className="flex gap-1" role="group" aria-label="View">
					<Button asChild variant="secondary" size="sm">
						<Link href="/campaigns" aria-current="page">
							<List data-icon="inline-start" />
							List
						</Link>
					</Button>
					<Button asChild variant="ghost" size="sm">
						<Link href="/campaigns/calendar">
							<CalendarDays data-icon="inline-start" />
							Calendar
						</Link>
					</Button>
				</div>
				<ButtonNewCampaign newsletterId={selected ? String(selected._id) : null} />
			</HeaderPage>

			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title="No campaigns yet" />
			) : (
				<ProviderCampaignSelection>
					<div className="animate-enter">
						<TableCampaigns campaigns={campaigns} newsletter={selected} hasActions pageUrls={pageUrls} />
					</div>
					<BarBulkCampaigns newsletters={newsletters.map(({ _id, name }) => ({ id: String(_id), name }))} currentNewsletterId={String(selected._id)} />
				</ProviderCampaignSelection>
			)}
		</>
	);
}
