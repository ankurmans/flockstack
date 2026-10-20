import { notFound } from "next/navigation";
import { Inbox } from "lucide-react";
import CardCustomRequest from "@/components/CardCustomRequest";
import CardStat from "@/components/CardStat";
import HeaderPage from "@/components/HeaderPage";
import ListTally from "@/components/ListTally";
import StateEmpty from "@/components/StateEmpty";
import { requireAdmin } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { listCustomRequests } from "@/lib/custom-requests";
import { tallyCustomRequests } from "@/lib/custom-rules";
import { formatNumber } from "@/lib/format";
import { serialize } from "@/lib/serialize";

export const metadata = { title: "Custom plan requests" };

const MONTHS_SHOWN = 12;

function formatMonth(month) {
	return new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// The Custom plan's requests (/custom), newest first, with what people ticked counted at the top: the longest bar is what
// to build first. Each region keeps its own requests, so this is this Worker's.
export default async function CustomRequestsPage() {
	await requireAdmin();
	if (!isCloud()) notFound();
	const requests = await listCustomRequests();
	const tally = tallyCustomRequests(requests);
	const open = requests.filter(({ status }) => status === "new").length;

	return (
		<>
			<HeaderPage title="Custom plan requests" backHref="/admin" />
			<div className="flex flex-col gap-8">
				<div className="grid gap-3 sm:grid-cols-3 animate-enter">
					<CardStat label="Requests" value={formatNumber(tally.total)} detail="In this region" />
					<CardStat label="New" value={formatNumber(open)} detail={open > 0 && "Reply within 2 business days"} tone={open > 0 ? "warn" : "default"} />
					<CardStat label="Won" value={formatNumber(requests.filter(({ status }) => status === "won").length)} tone="good" />
				</div>

				{tally.total > 0 && (
					<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
						<h2 className="text-sm font-medium text-muted-foreground">What people would need</h2>
						<div className="grid gap-6 rounded-xl bg-card p-4 shadow-border sm:p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
							<div data-tally="needs">
								<p className="mb-3 text-xs text-muted-foreground">Requests that ticked each one. The longest is what to build first.</p>
								<ListTally rows={tally.needs.map(({ id, label, count }) => ({ key: id, label, count }))} />
							</div>
							<div className="flex flex-col gap-6">
								<div data-tally="subscribers">
									<p className="mb-3 text-xs text-muted-foreground">Requests by subscribers</p>
									<ListTally rows={tally.subscribers.map(({ id, label, count }) => ({ key: id, label, count }))} />
								</div>
								<div data-tally="months">
									<p className="mb-3 text-xs text-muted-foreground">Requests a month</p>
									<ListTally
										rows={tally.months.slice(-MONTHS_SHOWN).map(({ month, count }) => ({ key: month, label: formatMonth(month), count }))}
									/>
								</div>
							</div>
						</div>
					</section>
				)}

				<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Requests, newest first</h2>
					{requests.length === 0 ? (
						<StateEmpty icon={Inbox} title="No requests yet" />
					) : (
						serialize(requests).map((request) => <CardCustomRequest key={request._id} request={request} />)
					)}
				</section>
			</div>
		</>
	);
}
