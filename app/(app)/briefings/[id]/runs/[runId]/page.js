import { Newspaper } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonsVerdict from "@/components/ButtonsVerdict";
import CardSettings from "@/components/CardSettings";
import HeaderPage from "@/components/HeaderPage";
import ImageLinkPreview from "@/components/ImageLinkPreview";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { requireAccount } from "@/lib/auth";
import { isValidObjectId } from "@/lib/docdb";

export const metadata = { title: "Briefing run" };

const SECTION_STATUSES = { written: "ok", empty: "paused", skipped_budget: "pending", failed: "failed" };
const SECTION_LABELS = { written: "Written", empty: "Empty", skipped_budget: "Skipped: budget", failed: "Failed" };
const SOURCE_LABELS = { press_release: "Press release", filing: "Filing", regulator: "Regulator", company: "Company", community: "Community" };

// One run of a briefing through get_briefing_run: its sections, its stories with keep and drop, what discovery searched and could
// not do, the checks.
export default async function BriefingRunPage({ params }) {
	const [{ id, runId }, { account, user }] = await Promise.all([params, requireAccount()]);
	if (!isValidObjectId(id) || !isValidObjectId(runId)) notFound();
	let run;
	try {
		run = await runAction("get_briefing_run", { account, user, input: { id: runId }, via: "dashboard" });
	} catch (error) {
		if (error?.code === "not_found") notFound();
		throw error;
	}
	if (run.briefingId !== id) notFound();
	const sectionTitles = new Map(run.sections.map(({ id: sectionId, title }) => [sectionId, title]));

	return (
		<>
			<HeaderPage title={`Run of ${run.slot.startsWith("manual:") ? run.slot.slice(7, 17) : run.slot}`} backHref={`/briefings/${id}`} meta={<BadgeStatus status={run.status} />}>
				{run.campaignId && (
					<Link href={`/campaigns/${run.campaignId}`} className="text-sm text-link hover:underline">
						Open the draft
					</Link>
				)}
			</HeaderPage>
			<div className="flex max-w-3xl flex-col gap-4">
				{run.sections.length > 0 && (
					<CardSettings title="Sections">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Section</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Items</TableHead>
									<TableHead className="pr-4 text-right">Cost</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{run.sections.map((section) => (
									<TableRow key={section.id}>
										<TableCell className="max-w-0 py-3 pl-4">
											<span className="block truncate font-medium">{section.title || section.id}</span>
											{section.problem && <span className="block truncate text-xs text-muted-foreground" title={section.problem}>{section.problem}</span>}
										</TableCell>
										<TableCell>{section.status ? <BadgeStatus status={SECTION_STATUSES[section.status]} label={SECTION_LABELS[section.status]} /> : <span className="text-muted-foreground">Not yet</span>}</TableCell>
										<TableCell className="text-right tabular-nums">{section.items}</TableCell>
										<TableCell className="pr-4 text-right tabular-nums">${section.costUsd.toFixed(4)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardSettings>
				)}
				<CardSettings title="Stories">
					{run.stories.length === 0 ? (
						<StateEmpty isCompact icon={Newspaper} title="No stories in this run" />
					) : (
						<ul className="divide-y">
							{run.stories.map((story) => (
								<li key={story.storyKey || story.url} className="flex flex-wrap items-center gap-3 px-4 py-3">
									<ImageLinkPreview src={story.previewImage} alt={story.title || story.url} size={48} />
									<span className="min-w-0 flex-1">
										<a href={story.url} target="_blank" rel="noreferrer noopener" className="block truncate text-sm font-medium hover:underline">
											{story.title || story.url}
										</a>
										<span className="block text-xs text-muted-foreground">
											{[sectionTitles.get(story.sectionId) ?? (story.kind === "brief" ? "One-line item" : "Full story"), SOURCE_LABELS[story.sourceKind], story.score !== null && `score ${Math.round(story.score)}`].filter(Boolean).join(", ")}
										</span>
									</span>
									{story.storyKey && <ButtonsVerdict briefingId={id} runId={run.id} storyKey={story.storyKey} verdict={story.verdict} />}
								</li>
							))}
						</ul>
					)}
				</CardSettings>
				<CardSettings title="Discovery">
					<div className="flex flex-col gap-2 px-4 py-3 text-sm">
						<p className="text-muted-foreground">
							{run.counts.queries} searches, {run.counts.candidates} candidates, {run.counts.fresh} new, {run.counts.shortlisted} shortlisted, {run.counts.picked} picked.
							{run.thin && " This run was thin: discovery found less than usual."}
						</p>
						{run.queries.length > 0 && (
							<ul className="list-disc pl-5">
								{run.queries.map((query, index) => (
									<li key={index}>
										{query.text}
										{query.angle && <span className="text-muted-foreground"> ({query.angle})</span>}
									</li>
								))}
							</ul>
						)}
						{run.discoveryNotes.map((note, index) => (
							<p key={index} className="text-muted-foreground">
								{note.provider}: {note.problem}
							</p>
						))}
						<p className="text-xs text-muted-foreground">
							News search by the{" "}
							<a href="https://www.gdeltproject.org/" target="_blank" rel="noreferrer noopener" className="underline">
								GDELT Project
							</a>
							, Hacker News through Algolia, the outlets&apos; own feeds and your own search key when you have one.
						</p>
					</div>
				</CardSettings>
				<CardSettings title="Checks and cost">
					<ul className="flex flex-col gap-1 px-4 py-3 text-sm">
						{run.checks.map((check) => (
							<li key={check.id} className="flex items-start gap-2">
								<BadgeStatus status={check.status === "pass" ? "ok" : check.status === "warning" ? "pending" : "failed"} label={check.status} />
								<span>{check.message}</span>
							</li>
						))}
						<li className="text-muted-foreground tabular-nums">Model cost: ${run.costUsd.toFixed(4)}</li>
						{run.error && <li className="text-muted-foreground">{run.error}</li>}
					</ul>
				</CardSettings>
			</div>
		</>
	);
}
