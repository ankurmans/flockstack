import Link from "next/link";
import { redirect } from "next/navigation";
import { FormInput, Plus } from "lucide-react";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Forms" };

export default async function FormsPage() {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const { output } = await runDashboardAction("list_forms", { newsletter: String(selected._id) });
	const forms = output?.forms ?? [];

	return (
		<>
			<HeaderPage title="Forms">
				<Button asChild>
					<Link href="/forms/new">
						<Plus data-icon="inline-start" />
						New
					</Link>
				</Button>
			</HeaderPage>

			{forms.length === 0 ? (
				<StateEmpty icon={FormInput} title="No forms yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						Put a signup form on another site: one line of code frames it, or a plain HTML form posts to it. Each form counts its own views and signups.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead className="text-right">Views</TableHead>
								<TableHead className="text-right">Signups</TableHead>
								<TableHead className="pr-4 text-right">Conversion</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{forms.map((form) => (
								<TableRow key={form.id} className="tabular-nums">
									<TableCell className="max-w-0 truncate py-3 pl-4 font-medium">
										<Link href={`/forms/${form.id}`} className="hover:underline">
											{form.name}
										</Link>
									</TableCell>
									<TableCell className="text-right">{formatNumber(form.views)}</TableCell>
									<TableCell className="text-right">{formatNumber(form.signups)}</TableCell>
									<TableCell className="pr-4 text-right">{form.conversion === null ? "-" : `${(form.conversion * 100).toFixed(1)}%`}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
