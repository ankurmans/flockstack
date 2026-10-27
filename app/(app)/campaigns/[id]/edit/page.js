import { isValidObjectId } from "@/lib/docdb";
import { notFound, redirect } from "next/navigation";
import FormPublishedIssue from "@/components/FormPublishedIssue";
import { scoped } from "@/lib/account-scope";
import { runAction } from "@/lib/actions/run-action";
import { getAiBinding } from "@/lib/ai";
import { hasActiveSubscription } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { listCustomFields } from "@/lib/custom-fields";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";
import { getGiphyKey } from "@/lib/giphy";
import { getUnsplashKey } from "@/lib/unsplash";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Edit web version" };

// A sent issue's page on the website, edited apart from the emails that went out (update_published_issue). Only a finished
// send that has a page: anything else goes back to the campaign.
export default async function EditPublishedPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { user, account } = view;
	if (!isValidObjectId(id)) notFound();

	const campaign = await Campaign.findOne(scoped(account, { _id: id })).lean();
	if (!campaign) notFound();
	openNewsletter(view, campaign.newsletterId, `/campaigns/${id}/edit`);
	if (campaign.status !== "sent" || campaign.publishTo === "email" || campaign.resend?.of || campaign.abTest?.status === "testing") redirect(`/campaigns/${id}`);
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	if (!newsletter) notFound();

	const [ai, fields, { snippets }] = await Promise.all([
		getAiBinding(),
		listCustomFields(account, newsletter._id),
		runAction("list_snippets", { account, user, via: "dashboard", input: { newsletter: String(newsletter._id) } }),
	]);

	return (
		<FormPublishedIssue
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			pageUrl={newsletter.archiveEnabled && campaign.archiveSlug ? getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug) : null}
			fields={fields.map(({ key, label, type }) => ({ key, label, type }))}
			snippets={snippets.map(({ name, content }) => ({ name, content }))}
			isAiEnabled={Boolean(ai) && hasActiveSubscription(account)}
			hasStockPhotos={Boolean(getUnsplashKey())}
			hasGifs={Boolean(getGiphyKey())}
		/>
	);
}
