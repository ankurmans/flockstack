import { redirect } from "next/navigation";
import { Trophy } from "lucide-react";
import FormReferrals from "@/components/FormReferrals";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatDate, formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Referrals" };

// The open newsletter's referral program: its settings and rewards, who has brought in the most subscribers, and the
// referrals that never counted, with why.
export default async function ReferralsPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const [settings, leaderboard, rejected] = await Promise.all([
		runDashboardAction("get_referral_settings", { newsletter }),
		runDashboardAction("get_referral_leaderboard", { newsletter, limit: 10 }),
		runDashboardAction("list_referrals", { newsletter, status: "rejected", limit: 10 }),
	]);

	return (
		<>
			<HeaderPage title="Referrals" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				{settings.output && (
					<>
						<Totals totals={settings.output.totals} />
						<FormReferrals key={newsletter} newsletterId={newsletter} settings={settings.output} />
					</>
				)}
				{leaderboard.output && (
					<section style={{ "--stagger": 4 }} className="animate-enter">
						<h2 className="mb-3 text-sm font-medium">Leaderboard</h2>
						{leaderboard.output.referrers.length === 0 ? (
							<StateEmpty icon={Trophy} title="No referrals yet" />
						) : (
							<div className="overflow-hidden rounded-xl shadow-border">
								<Table>
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead className="w-12 pl-4">#</TableHead>
											<TableHead>Subscriber</TableHead>
											<TableHead className="pr-4 text-right">Referrals</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{leaderboard.output.referrers.map((referrer, index) => (
											<TableRow key={referrer.id} className="tabular-nums">
												<TableCell className="pl-4 text-muted-foreground">{index + 1}</TableCell>
												<TableCell className="max-w-0 truncate font-medium">{referrer.email}</TableCell>
												<TableCell className="pr-4 text-right">{formatNumber(referrer.referrals)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</section>
				)}
				{rejected.output?.referrals.length > 0 && (
					<section style={{ "--stagger": 5 }} className="animate-enter">
						<h2 className="mb-1 text-sm font-medium">Referrals that didn&apos;t count</h2>
						<p className="mb-3 text-sm text-pretty text-muted-foreground">
							Self-referrals, repeats from one inbox or network, and floods. The new subscribers are on your list as usual.
						</p>
						<div className="overflow-hidden rounded-xl shadow-border">
							<Table>
								<TableBody>
									{rejected.output.referrals.map((referral) => (
										<TableRow key={referral.id}>
											<TableCell className="max-w-0 py-2.5 pl-4">
												<span className="block truncate font-medium">{referral.referred.email ?? "A deleted contact"}</span>
												<span className="block truncate text-xs text-muted-foreground">
													from {referral.referrer.email ?? "a deleted contact"}: {referral.reason}
												</span>
											</TableCell>
											<TableCell className="pr-4 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
												{formatDate(referral.createdAt)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</section>
				)}
			</div>
		</>
	);
}

function Totals({ totals }) {
	const stats = [
		{ label: "Counted", value: totals.credited },
		{ label: "Waiting to confirm", value: totals.pending },
		{ label: "Didn't count", value: totals.rejected },
		{ label: "Referrers", value: totals.referrers },
	];
	return (
		<dl style={{ "--stagger": 0 }} className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/60 shadow-border animate-enter sm:grid-cols-4">
			{stats.map(({ label, value }) => (
				<div key={label} className="bg-card px-4 py-3">
					<dt className="text-xs text-muted-foreground">{label}</dt>
					<dd className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(value)}</dd>
				</div>
			))}
		</dl>
	);
}
