import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { formatNumber } from "@/lib/format";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Surveys" };

// The open newsletter's surveys, as list_surveys reads them.
export default async function SurveysPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	const { surveys } = selected ? await runAction("list_surveys", { account, user, input: { newsletter: String(selected._id) }, via: "dashboard" }) : { surveys: [] };

	return (
		<>
			<HeaderPage title="Surveys">
				<Button asChild disabled={!selected}>
					<Link href="/surveys/new">
						<Plus data-icon="inline-start" />
						New
					</Link>
				</Button>
			</HeaderPage>

			{surveys.length === 0 ? (
				<StateEmpty icon={ClipboardList} title="No surveys yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						Ask readers a few questions on your website, right after they sign up or when they unsubscribe. Answers can fill in their
						custom fields.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Title</TableHead>
								<TableHead className="hidden md:table-cell">Shown</TableHead>
								<TableHead className="pr-4 text-right">Responses</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{surveys.map((survey) => (
								<TableRow key={survey.id} className="tabular-nums">
									<TableCell className="py-3 pl-4 font-medium">
										<Link href={`/surveys/${survey.id}`} className="hover:underline">
											{survey.title}
										</Link>
									</TableCell>
									<TableCell className="hidden text-muted-foreground md:table-cell">
										{[survey.closed && "Closed", survey.afterSignup && "After signup", survey.onUnsubscribe && "On unsubscribe"].filter(Boolean).join(" · ") || "Its own page"}
									</TableCell>
									<TableCell className="pr-4 text-right">{formatNumber(survey.responses)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
