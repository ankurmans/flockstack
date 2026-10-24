import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonDeleteContent from "@/components/ButtonDeleteContent";
import FormContentItem from "@/components/FormContentItem";
import FormContentPlan from "@/components/FormContentPlan";
import FormContentPublication from "@/components/FormContentPublication";
import HeaderPage from "@/components/HeaderPage";
import PanelContentAssets from "@/components/PanelContentAssets";
import PanelContentCampaign from "@/components/PanelContentCampaign";
import PanelContentReview from "@/components/PanelContentReview";
import PanelContentRevisions from "@/components/PanelContentRevisions";
import { runAction } from "@/lib/actions/run-action";
import { listUnplannedDrafts } from "@/lib/content-plan";
import { CHANNEL_LABELS, STATE_LABELS } from "@/lib/content-rules";
import { isValidObjectId } from "@/lib/docdb";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/lib/time-zone";

export const metadata = { title: "Content item" };

// One item of the content plan, all of it together: copy, notes, call to action, references and visuals to edit, the review and
// what is missing, the planned day, the issue it links, where it was published and the revisions. Read through the same
// actions as the API.
export default async function ContentItemPage({ params }) {
	const [{ id }, view, cookieStore] = await Promise.all([params, getSelectedNewsletter(), cookies()]);
	const { account, user } = view;
	if (!isValidObjectId(id)) notFound();
	const run = (name, input) => runAction(name, { account, user, input, via: "dashboard" });
	const item = await run("get_content_item", { id }).catch((error) => (error?.code === "not_found" ? null : Promise.reject(error)));
	if (!item) notFound();
	openNewsletter(view, item.newsletterId, `/campaigns/calendar/items/${id}`);
	const [{ revisions }, { batches }, { media }, drafts] = await Promise.all([
		run("list_content_revisions", { id, limit: 20 }),
		run("list_editorial_batches", { newsletter: item.newsletterId, status: "active", limit: 100 }),
		run("list_media", { limit: 100 }),
		listUnplannedDrafts(account, item.newsletterId, { limit: 30 }),
	]);
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	// A panel starts over from the server's copy when what it shows changed elsewhere (a restored revision), and not when something else did.
	const formKey = JSON.stringify([item.title, item.funnelStage, item.pillar, item.obstacle, item.takeaway, item.hook, item.body, item.cta, item.destinationUrl, item.notes, item.references, item.batchId]);
	const assetsKey = JSON.stringify(item.assets.map((asset) => [asset.mediaId, asset.altText]));
	const library = media.filter((file) => file.kind === "image" || file.contentType === "application/pdf");

	return (
		<>
			<HeaderPage title={item.title || "Untitled"} backHref="/campaigns/calendar" meta={<BadgeStatus status={item.state} label={STATE_LABELS[item.state]} />}>
				<span className="text-sm text-muted-foreground">{CHANNEL_LABELS[item.channel]}</span>
				<ButtonDeleteContent id={item.id} />
			</HeaderPage>
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
				<FormContentItem key={formKey} item={item} batches={batches.map(({ id: batchId, name }) => ({ id: batchId, name }))} />
				<div className="flex flex-col gap-5 self-start">
					<PanelContentReview item={item} />
					<FormContentPlan item={item} defaultTimeZone={timeZone} />
					<PanelContentCampaign item={item} drafts={drafts.map((draft) => ({ id: String(draft._id), subject: draft.subject }))} />
					<PanelContentAssets key={assetsKey} item={item} library={library} />
					<FormContentPublication item={item} />
					<PanelContentRevisions itemId={item.id} revisions={revisions} />
				</div>
			</div>
		</>
	);
}
