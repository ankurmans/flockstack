import Link from "next/link";
import { notFound } from "next/navigation";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings from "@/components/CardSettings";
import FormBriefing from "@/components/FormBriefing";
import HeaderPage from "@/components/HeaderPage";
import TimeLocal from "@/components/TimeLocal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { isValidObjectId } from "@/lib/docdb";
import { READER_LANGUAGES } from "@/lib/reader-language-copy";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Briefing" };

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// "2 passed, 1 warning"
function describeChecks(checks) {
	const count = (status) => checks.filter((check) => check.status === status).length;
	const parts = [
		count("blocker") && `${count("blocker")} blocking`,
		count("warning") && `${count("warning")} ${count("warning") === 1 ? "warning" : "warnings"}`,
		count("pass") && `${count("pass")} passed`,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "None yet";
}

// A briefing's settings and its runs, through get_briefing and list_briefing_runs as the API reads them.
export default async function BriefingPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account, user } = view;
	if (!isValidObjectId(id)) notFound();
	let briefing;
	try {
		briefing = await runAction("get_briefing", { account, user, input: { id }, via: "dashboard" });
	} catch (error) {
		if (error?.code === "not_found") notFound();
		throw error;
	}
	openNewsletter(view, briefing.newsletterId, `/briefings/${id}`);
	const [{ runs }, { keys }] = await Promise.all([
		runAction("list_briefing_runs", { account, user, input: { id }, via: "dashboard" }),
		runAction("list_ai_keys", { account, user, input: {}, via: "dashboard" }),
	]);

	return (
		<>
			<HeaderPage title={briefing.name} backHref="/briefings" meta={<BadgeStatus status={briefing.status} />} />
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
				<FormBriefing newsletterId={briefing.newsletterId} briefing={briefing} keys={keys} languages={READER_LANGUAGES} defaultTimeZone={briefing.schedule.timeZone} />
				<CardSettings title="Runs" className="self-start">
					{runs.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">{briefing.manualRunAt ? "A run is waiting to start." : "Nothing has run yet."}</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">When</TableHead>
									<TableHead>Result</TableHead>
									<TableHead className="text-right">Stories</TableHead>
									<TableHead className="pr-4 text-right">Cost</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.map((run) => (
									<TableRow key={run.id}>
										<TableCell className="py-3 pl-4 text-muted-foreground tabular-nums">
											<Link href={`/briefings/${id}/runs/${run.id}`} className="hover:underline">
												<TimeLocal value={run.startedAt ?? run.createdAt} options={WHEN} />
											</Link>
											{run.isManual && <span className="block text-xs">Run by hand</span>}
										</TableCell>
										<TableCell className="max-w-0">
											<BadgeStatus status={run.status} />
											<span className="mt-1 block truncate text-xs text-muted-foreground">Checks: {describeChecks(run.checks)}</span>
											{run.error && <span className="mt-1 block truncate text-xs text-muted-foreground" title={run.error}>{run.error}</span>}
											{run.campaignId && (
												<Link href={`/campaigns/${run.campaignId}`} className="mt-1 block text-xs text-link hover:underline">
													Open the draft
												</Link>
											)}
										</TableCell>
										<TableCell className="text-right tabular-nums">{run.counts.picked}</TableCell>
										<TableCell className="pr-4 text-right tabular-nums">${run.costUsd.toFixed(run.costUsd < 0.01 ? 4 : 2)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardSettings>
			</div>
		</>
	);
}
