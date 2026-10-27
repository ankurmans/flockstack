import { redirect } from "next/navigation";
import Link from "next/link";
import FormRecommendations from "@/components/FormRecommendations";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { REGION_RULE } from "@/lib/recommendation-rules";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Recommendations" };

// The open newsletter's recommendations: what it recommends and what that brought, who recommends it, and its settings.
export default async function RecommendationsPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const [list, stats] = await Promise.all([
		runDashboardAction("list_recommendations", { newsletter }),
		runDashboardAction("get_recommendation_stats", { newsletter }),
	]);

	return (
		<>
			<HeaderPage title="Recommendations" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				<Link href="/recommending/creators" className="text-sm underline">Find creators and private introductions</Link>
				{stats.output && <Totals stats={stats.output} />}
				{list.output && <FormRecommendations key={newsletter} newsletterId={newsletter} data={list.output} />}
				<p className="text-xs text-pretty text-muted-foreground">
					Free for everyone: no paid placement and no cut of anyone&apos;s revenue. {REGION_RULE}
				</p>
			</div>
		</>
	);
}

function Totals({ stats }) {
	const groups = [
		{
			title: "Your recommendations",
			values: [
				{ label: "Times shown", value: stats.given.impressions },
				{ label: "Readers sent", value: stats.given.signups },
				{ label: "Confirmed", value: stats.given.confirmed },
			],
		},
		{
			title: "Recommendations of you",
			values: [
				{ label: "Times shown", value: stats.received.impressions },
				{ label: "Subscribers gained", value: stats.received.signups },
				{ label: "Confirmed", value: stats.received.confirmed },
			],
		},
	];
	return (
		<div style={{ "--stagger": 0 }} className="grid gap-4 animate-enter sm:grid-cols-2">
			{groups.map(({ title, values }) => (
				<dl key={title} className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-border/60 shadow-border">
					<dt className="col-span-3 bg-card px-4 pt-3 text-xs font-medium">{title}</dt>
					{values.map(({ label, value }) => (
						<div key={label} className="bg-card px-4 pt-1 pb-3">
							<dd className="text-xl font-semibold tabular-nums">{formatNumber(value)}</dd>
							<dt className="text-xs text-muted-foreground">{label}</dt>
						</div>
					))}
				</dl>
			))}
		</div>
	);
}
