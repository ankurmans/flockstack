import { Send } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import { runAction } from "@/lib/actions/run-action";
import { getIssuePageUrl } from "@/lib/archive-data";
import { listNewsletterCampaigns } from "@/lib/campaign-queries";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	const campaigns = selected ? await listNewsletterCampaigns(account, selected._id, 200) : [];
	const { templates } = selected
		? await runAction("list_templates", { account, user, via: "dashboard", input: { newsletter: String(selected._id) } })
		: { templates: [] };
	const pageUrls = Object.fromEntries(
		campaigns
			.map((campaign) => [campaign._id.toString(), getIssuePageUrl({ campaign, newsletter: selected })])
			.filter(([, url]) => url)
	);

	return (
		<>
			<HeaderPage title="Campaigns">
				<ButtonNewCampaign newsletterId={selected ? String(selected._id) : null} templates={templates.map(({ id, name }) => ({ id, name }))} />
			</HeaderPage>

			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title="No campaigns yet" />
			) : (
				<div className="animate-enter">
					<TableCampaigns campaigns={campaigns} newsletter={selected} hasActions pageUrls={pageUrls} />
				</div>
			)}
		</>
	);
}
