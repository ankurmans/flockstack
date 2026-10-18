import Link from "next/link";
import { Filter, Plus } from "lucide-react";
import HeaderPage from "@/components/HeaderPage";
import MenuSegment from "@/components/MenuSegment";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { scoped } from "@/lib/account-scope";
import { formatNumber } from "@/lib/format";
import { describeRules } from "@/lib/segment-rules";
import { previewRules } from "@/lib/segments";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import Segment from "@/models/Segment";

export const metadata = { title: "Segments" };

// The open newsletter's saved audiences, with how many contacts each matches right now.
export default async function SegmentsPage() {
	const { account, selected } = await getSelectedNewsletter();
	const segments = selected ? await Segment.find(scoped(account, { newsletterId: selected._id })).sort({ name: 1 }).lean() : [];
	const counts = await Promise.all(segments.map((segment) => previewRules(account, selected._id, segment.rules, { sample: 0 })));

	return (
		<>
			<HeaderPage title="Segments">
				<Button asChild disabled={!selected}>
					<Link href="/segments/new">
						<Plus data-icon="inline-start" />
						New
					</Link>
				</Button>
			</HeaderPage>

			{segments.length === 0 ? (
				<StateEmpty icon={Filter} title="No segments yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						A segment is a saved audience: readers with a tag, who opened lately, who signed up after a date. Send a campaign to one, or
						start an automation from it.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead className="hidden md:table-cell">Rules</TableHead>
								<TableHead className="text-right">Matching</TableHead>
								<TableHead className="hidden text-right sm:table-cell">Active</TableHead>
								<TableHead className="w-12 pr-2" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{segments.map((segment, index) => (
								<TableRow key={String(segment._id)} className="tabular-nums">
									<TableCell className="py-3 pl-4 font-medium">
										<Link href={`/segments/${segment._id}`} className="hover:underline">
											{segment.name}
										</Link>
									</TableCell>
									<TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">{describeRules(segment.rules)}</TableCell>
									<TableCell className="text-right">{formatNumber(counts[index].matching)}</TableCell>
									<TableCell className="hidden text-right sm:table-cell">{formatNumber(counts[index].active)}</TableCell>
									<TableCell className="pr-2 text-right">
										<MenuSegment id={String(segment._id)} name={segment.name} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
