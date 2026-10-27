import FormGiftLinks from "@/components/FormGiftLinks";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Gift links" };

export default async function GiftLinksPage() {
	const { selected } = await getSelectedNewsletter();
	const newsletter = String(selected._id);
	const [links, issues] = await Promise.all([
		runDashboardAction("list_gift_links", { newsletter, limit: 100 }),
		runDashboardAction("list_campaigns", { newsletter, status: "sent", kind: "issue", limit: 200 }),
	]);
	const failure = links.failure ?? issues.failure;
	return (
		<>
			<HeaderPage title="Gift links" />
			{failure ? (
				<p role="alert" className="text-sm text-destructive">
					{failure.message}
				</p>
			) : (
				<FormGiftLinks
					newsletter={newsletter}
					settings={links.output.settings}
					links={links.output.links}
					issues={issues.output.campaigns.filter((issue) => issue.audience === "paid" && issue.archiveUrl).map(({ id, subject }) => ({ id, subject }))}
				/>
			)}
		</>
	);
}
