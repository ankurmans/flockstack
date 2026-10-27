import Link from "next/link";
import { CalendarDays, List, Send } from "lucide-react";
import FilterTag from "@/components/FilterTag";
import NavFilters from "@/components/NavFilters";
import BarBulkCampaigns from "@/components/BarBulkCampaigns";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import ProviderCampaignSelection from "@/components/ProviderCampaignSelection";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/actions/run-action";
import { getIssuePageUrl } from "@/lib/archive-data";
import { listNewsletterCampaigns } from "@/lib/campaign-queries";
import { getTagSlug } from "@/lib/issue-tags";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Campaigns" };

// The names of the tags the listed campaigns carry, for the tag filter; two that read the same in a web address are one.
function collectTags(campaigns) {
	const bySlug = new Map(campaigns.flatMap((campaign) => campaign.tags ?? []).map((name) => [getTagSlug(name), name]));
	return [...bySlug.values()].toSorted((a, b) => a.localeCompare(b));
}

export default async function CampaignsPage({ searchParams }) {
	const [{ account, user, selected, newsletters }, params] = await Promise.all([getSelectedNewsletter(), searchParams]);
	const archived = params?.view === "archived";
	const [everything, { templates }] = selected
		? await Promise.all([
				listNewsletterCampaigns(account, selected._id, 200, { archived }),
				runAction("list_templates", { account, user, via: "dashboard", input: { newsletter: String(selected._id) } }),
			])
		: [[], { templates: [] }];
	const tags = collectTags(everything);
	const tag = typeof params?.tag === "string" && tags.includes(params.tag) ? params.tag : null;
	const campaigns = tag ? await listNewsletterCampaigns(account, selected._id, 200, { archived, tagSlug: getTagSlug(tag) }) : everything;
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
				<ButtonNewCampaign newsletterId={selected ? String(selected._id) : null} templates={templates.map(({ id, name }) => ({ id, name }))} />
			</HeaderPage>

			{selected && (everything.length > 0 || archived) && (
				<div className="mb-4 flex flex-wrap items-center gap-3">
					<NavFilters label="Show" name="view" current={archived ? "archived" : "active"} options={[["active", "Campaigns"], ["archived", "Archived"]]} base="/campaigns" query={{}} />
					{tags.length > 0 && <FilterTag key={`${selected._id}-${archived}`} tags={tags} />}
				</div>
			)}
			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title={tag ? `No campaigns tagged ${tag}` : archived ? "Nothing archived" : "No campaigns yet"} />
			) : (
				<ProviderCampaignSelection>
					<div className="animate-enter">
						<TableCampaigns campaigns={campaigns} newsletter={selected} hasActions pageUrls={pageUrls} />
					</div>
					<BarBulkCampaigns authors={selected.authors ?? []} newsletters={newsletters.map(({ _id, name }) => ({ id: String(_id), name }))} currentNewsletterId={String(selected._id)} isArchivedView={archived} />
				</ProviderCampaignSelection>
			)}
		</>
	);
}
