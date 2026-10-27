import { listCustomFields } from "@/lib/custom-fields";
import { getNewsletterTiers } from "@/lib/tier-rules";
import { getAiBinding } from "@/lib/ai";
import { getUnsplashKey } from "@/lib/unsplash";
import Link from "next/link";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import CollaborativeCampaign from "@/components/CollaborativeCampaign";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit together" };
export default async function CollaborativeCampaignPage({ params }) {
	const { id } = await params, context = await getSelectedNewsletter();
	const campaign = await runDashboardAction("get_campaign", { id });
	if (campaign.failure) return <LayoutNarrow><p role="alert">{campaign.failure.message}</p></LayoutNarrow>;
	openNewsletter(context, campaign.output.newsletterId, `/campaigns/${id}/collaborate`);
	if (process.env.COLLABORATION_ENABLED !== "true" || campaign.output.status !== "draft" || campaign.output.format !== "rich") return <LayoutNarrow><HeaderPage title="Edit together" /><p>Realtime editing needs a rich-text draft and the optional collaboration Worker enabled on this server.</p><Link href={`/campaigns/${id}`}>Return to issue</Link></LayoutNarrow>;
	const [collaborators, snippets, fields, ai] = await Promise.all([runDashboardAction("list_editor_collaborators", { id }), runDashboardAction("list_snippets", { newsletter: campaign.output.newsletterId }), listCustomFields(context.account, campaign.output.newsletterId), getAiBinding()]);
	return <div className="mx-auto w-full max-w-7xl"><HeaderPage title="Edit together" /><CollaborativeCampaign viewerId={String(context.user.id)} id={id} newsletterId={campaign.output.newsletterId} collaborators={collaborators.output?.collaborators ?? []} editorOptions={{ fields: fields.map(({ key, label, type }) => ({ key, label, type })), snippets: (snippets.output?.snippets ?? []).map(({ name, content }) => ({ name, content })), tiers: getNewsletterTiers(context.selected), isAiEnabled: Boolean(ai), hasStockPhotos: Boolean(getUnsplashKey()) }} /></div>;
}
