import Link from "next/link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import CardAgentApproval from "@/components/CardAgentApproval";
import CardApproval from "@/components/CardApproval";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { scoped } from "@/lib/account-scope";
import { getStaleness, listApprovals, toApprovalView } from "@/lib/approvals";
import { requireAccount } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { formatRelative } from "@/lib/format";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Approvals" };

const HISTORY_LIMIT = 30;

export default async function ApprovalsPage() {
	const { account } = await requireAccount();
	await connectDb();
	const [pendingRows, decidedRows, newsletters] = await Promise.all([
		listApprovals(account, { status: "pending", limit: 50 }),
		listApprovals(account, { limit: HISTORY_LIMIT + 50 }),
		Newsletter.find(scoped(account)).sort({ createdAt: 1, _id: 1 }).select({ name: 1, agentApproval: 1 }).lean(),
	]);
	const pending = await Promise.all(
		pendingRows.map(async (approval) => ({ approval: toApprovalView(approval, { includeInput: true }), staleness: await getStaleness(account, approval) }))
	);
	const history = decidedRows
		.map((approval) => toApprovalView(approval))
		.filter(({ status }) => status !== "pending")
		.slice(0, HISTORY_LIMIT);

	return (
		<>
			<HeaderPage title="Approvals">
				<Button asChild variant="outline">
					<Link href="/agent-activity">Activity</Link>
				</Button>
				<Button asChild variant="outline">
					<Link href="/docs/agent-safety">
						Docs
						<ArrowUpRight data-icon="inline-end" className="opacity-60" />
					</Link>
				</Button>
			</HeaderPage>

			<div className="flex flex-col gap-8">
				<section className="flex flex-col gap-3">
					<h2 className="text-sm font-medium text-muted-foreground">Waiting for you</h2>
					{pending.length === 0 ? (
						<StateEmpty icon={ShieldCheck} title="Nothing is waiting for you">
							<p className="max-w-sm text-sm text-pretty text-muted-foreground">
								When an AI agent with a send with approval key asks to send, schedule or delete something, it shows up here and nothing happens until you say so.
							</p>
						</StateEmpty>
					) : (
						pending.map(({ approval, staleness }) => <CardApproval key={approval.id} approval={approval} staleness={staleness} />)
					)}
				</section>

				<CardAgentApproval newsletters={newsletters.map(({ _id, name, agentApproval }) => ({ id: String(_id), name, required: Boolean(agentApproval) }))} />

				{history.length > 0 && (
					<section className="flex flex-col gap-3">
						<h2 className="text-sm font-medium text-muted-foreground">Decided</h2>
						<div className="overflow-hidden rounded-xl shadow-border animate-enter">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="pl-4">Request</TableHead>
										<TableHead className="hidden sm:table-cell">Asked by</TableHead>
										<TableHead>Outcome</TableHead>
										<TableHead className="hidden md:table-cell">Your note</TableHead>
										<TableHead className="pr-4 text-right">When</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{history.map((approval) => (
										<TableRow key={approval.id}>
											<TableCell className="max-w-72 py-2.5 pl-4 break-words whitespace-normal">{approval.summary}</TableCell>
											<TableCell className="hidden text-muted-foreground sm:table-cell">{approval.actor.name}</TableCell>
											<TableCell>
												<BadgeStatus status={getOutcome(approval)} label={OUTCOME_LABELS[getOutcome(approval)]} />
											</TableCell>
											<TableCell className="hidden max-w-60 truncate text-muted-foreground md:table-cell">{approval.note ?? ""}</TableCell>
											<TableCell className="pr-4 text-right text-muted-foreground">{formatRelative(approval.decidedAt ?? approval.expiresAt)}</TableCell>
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

const OUTCOME_LABELS = { done: "Approved and done", failed: "Approved, failed", rejected: "Rejected", expired: "Expired", approved: "Approved" };

function getOutcome({ status, execution }) {
	if (status !== "approved") return status;
	if (execution.state === "done") return "done";
	return execution.state === "failed" ? "failed" : "approved";
}
