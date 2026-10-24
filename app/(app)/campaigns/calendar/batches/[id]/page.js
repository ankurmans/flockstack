import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import BarBatchReview from "@/components/BarBatchReview";
import ButtonDeleteContent from "@/components/ButtonDeleteContent";
import CardSettings from "@/components/CardSettings";
import FormBatchPattern from "@/components/FormBatchPattern";
import HeaderPage from "@/components/HeaderPage";
import ListBatchItems from "@/components/ListBatchItems";
import { runAction } from "@/lib/actions/run-action";
import { STATE_LABELS } from "@/lib/content-rules";
import { isValidObjectId } from "@/lib/docdb";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/lib/time-zone";

export const metadata = { title: "Batch" };

// One page for the owner to review a whole batch: every item in order with its state, day and what is missing, approve what is
// ready, ask for changes on the rest, and set a pattern for its days.
export default async function BatchPage({ params }) {
	const [{ id }, view, cookieStore] = await Promise.all([params, getSelectedNewsletter(), cookies()]);
	const { account, user } = view;
	if (!isValidObjectId(id)) notFound();
	const batch = await runAction("get_editorial_batch", { account, user, input: { id }, via: "dashboard" }).catch((error) => (error?.code === "not_found" ? null : Promise.reject(error)));
	if (!batch) notFound();
	openNewsletter(view, batch.newsletterId, `/campaigns/calendar/batches/${id}`);
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	const readyCount = batch.items.filter((item) => item.state === "ready_for_review" && item.canApprove).length;

	return (
		<>
			<HeaderPage title={batch.name} backHref="/campaigns/calendar">
				<ButtonDeleteContent id={batch.id} kind="batch" />
			</HeaderPage>
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
				<div className="flex flex-col gap-4">
					{batch.description && <p className="text-sm text-muted-foreground">{batch.description}</p>}
					<p className="text-sm text-muted-foreground">
						{batch.itemCount} {batch.itemCount === 1 ? "item" : "items"}
						{Object.entries(batch.counts).map(([state, count]) => ` · ${count} ${STATE_LABELS[state].toLowerCase()}`)}
					</p>
					<BarBatchReview batchId={batch.id} readyCount={readyCount} />
					<section className="rounded-xl bg-card shadow-border" aria-label="Items">
						<ListBatchItems batchId={batch.id} items={batch.items} />
					</section>
				</div>
				<CardSettings title="Recurring pattern" className="self-start">
					<FormBatchPattern batchId={batch.id} pattern={batch.pattern} timeZone={timeZone} />
				</CardSettings>
			</div>
		</>
	);
}
