import Link from "next/link";
import ButtonResumeNewsletter from "@/components/ButtonResumeNewsletter";
import FormFleetDomains from "@/components/FormFleetDomains";
import FormFleetRecommendation from "@/components/FormFleetRecommendation";
import HeaderPage from "@/components/HeaderPage";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatDate, formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH, getNewsletterPagePath } from "@/lib/newsletters";

export const metadata = { title: "Brand fleet" };
export const dynamic = "force-dynamic";

const rate = (value) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;

export default async function FleetPage() {
	const { output: fleet, failure } = await runDashboardAction("get_brand_fleet");
	if (failure) throw new Error(failure.message);
	const total = fleet.newsletters.reduce((sum, item) => sum + item.subscribers, 0);
	return (
		<>
			<HeaderPage title="Brand fleet"><Button asChild><Link href={ADD_NEWSLETTER_PATH}>Add a newsletter</Link></Button></HeaderPage>
			<div className="space-y-6">
				<p className="text-sm text-muted-foreground">{fleet.newsletters.length}{fleet.newsletterLimit !== null ? ` of ${fleet.newsletterLimit}` : ""} newsletters · {formatNumber(total)} subscriptions across lists. A reader on two lists counts twice.</p>
				<div className="overflow-x-auto rounded-xl bg-card shadow-border">
					<Table>
						<TableHeader><TableRow><TableHead>Newsletter</TableHead><TableHead className="text-right">Subscribers</TableHead><TableHead>Last issue</TableHead><TableHead className="text-right">Sent · 7 days</TableHead><TableHead className="text-right">Bounces</TableHead><TableHead className="text-right">Complaints</TableHead><TableHead>Sending</TableHead></TableRow></TableHeader>
						<TableBody>
							{fleet.newsletters.map((item) => <TableRow key={item.id}>
								<TableCell><Link href={getNewsletterPagePath(item.id, "/campaigns")} className="font-medium hover:underline">{item.name}</Link><p className="text-xs text-muted-foreground">{item.fromEmail}</p></TableCell>
								<TableCell className="text-right tabular-nums">{formatNumber(item.subscribers)}</TableCell>
								<TableCell>{item.lastSentAt ? formatDate(item.lastSentAt) : "No sent issue"}</TableCell>
								<TableCell className="text-right tabular-nums">{formatNumber(item.health.sent)}</TableCell>
								<TableCell className="text-right tabular-nums">{rate(item.health.bounceRate)}<p className="text-xs text-muted-foreground">{item.health.bounced} bounces</p></TableCell>
								<TableCell className="text-right tabular-nums">{rate(item.health.complaintRate)}<p className="text-xs text-muted-foreground">{item.health.complained} complaints</p></TableCell>
								<TableCell>{item.paused ? <div className="max-w-xs space-y-2"><p className="text-sm text-destructive">{item.reason}</p><ButtonResumeNewsletter id={item.id} /></div> : <span className="text-sm">No newsletter brake</span>}{item.warmup && <p className="mt-1 text-xs text-muted-foreground">{item.warmup.hasStarted ? `Warm-up day ${item.warmup.day} of ${item.warmup.days}` : "Warm-up starts with the first send"}</p>}</TableCell>
							</TableRow>)}
						</TableBody>
					</Table>
					{!fleet.newsletters.length && <p className="p-6 text-sm text-muted-foreground">Add your first newsletter to start your fleet.</p>}
				</div>
				<p className="text-xs text-muted-foreground">Rates count campaign, automation and signup emails sent in the last {fleet.periodDays} days, as of {new Date(fleet.asOf).toISOString()}. No sends means no rate. A newsletter pauses above {rate(fleet.limits.bounceRate)} with at least {fleet.limits.minBounces} bounces, or {rate(fleet.limits.complaintRate)} with at least {fleet.limits.minComplaints} complaints. Account and provider blocks still apply.</p>
				{fleet.domains.length > 0 && <FormFleetDomains domains={fleet.domains} />}
				{fleet.newsletters.length > 1 && <FormFleetRecommendation newsletters={fleet.newsletters} />}
			</div>
		</>
	);
}
