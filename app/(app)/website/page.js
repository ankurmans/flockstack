import { redirect } from "next/navigation";
import CardPages from "@/components/CardPages";
import FormNavigation from "@/components/FormNavigation";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Website" };

// The open newsletter's website beyond its issues: pages like About and Sponsor, the navigation bar and the tags. Its look
// is in Settings, under Brand.
export default async function WebsitePage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const [pages, navigation, tags] = await Promise.all([
		runDashboardAction("list_pages", { newsletter }),
		runDashboardAction("get_navigation", { newsletter }),
		runDashboardAction("list_issue_tags", { newsletter }),
	]);

	return (
		<LayoutNarrow>
			<HeaderPage title="Website" />
			<div className="flex flex-col gap-4">
				<CardPages key={`pages-${newsletter}`} newsletterId={newsletter} pages={pages.output?.pages ?? []} isOn={Boolean(selected.archiveEnabled)} />
				<FormNavigation key={`nav-${newsletter}`} newsletterId={newsletter} items={navigation.output?.items ?? []} pages={pages.output?.pages ?? []} />
				<section style={{ "--stagger": 2 }} className="rounded-xl bg-card shadow-border animate-enter">
					<div className="flex h-12 items-center border-b border-border/60 px-4">
						<h2 className="text-sm font-medium">Tags</h2>
					</div>
					{(tags.output?.tags ?? []).length === 0 ? (
						<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
							No issue has a tag yet. Add tags on an issue&apos;s Send step or its report, and each gets a page on your website.
						</p>
					) : (
						<ul className="divide-y divide-border/60">
							{tags.output.tags.map((tag) => (
								<li key={tag.slug} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
									<span className="min-w-0 truncate font-medium">{tag.name}</span>
									<span className="flex shrink-0 items-center gap-3 text-muted-foreground tabular-nums">
										{tag.issues} {tag.issues === 1 ? "issue" : "issues"}
										{tag.url && (
											<a href={tag.url} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
												View
											</a>
										)}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</LayoutNarrow>
	);
}
