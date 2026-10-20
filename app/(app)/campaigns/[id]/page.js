import { isValidObjectId } from "@/lib/docdb";
import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { scoped } from "@/lib/account-scope";
import { getAiBinding } from "@/lib/ai";
import { getAccountSendProblem, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { runAction } from "@/lib/actions/run-action";
import { countNewContacts, getSendVolumes, sendTimesPipeline } from "@/lib/campaign-queries";
import { isSendingEnabled } from "@/lib/config";
import { listCustomFields } from "@/lib/custom-fields";
import { findPolls } from "@/lib/editor-blocks";
import { getClickMapHtml, listCampaignLinks } from "@/lib/link-clicks";
import { MESSAGE_STATS_GROUP } from "@/lib/message-stats";
import { getUnsplashKey } from "@/lib/unsplash";
import { getPostalAddress } from "@/lib/postal-address";
import { isResend } from "@/lib/resend-rules";
import { countResendAudience } from "@/lib/resends";
import { countCampaignAudience } from "@/lib/segments";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { getPace } from "@/lib/send-spread";
import { serialize } from "@/lib/serialize";
import { loadSender } from "@/lib/sender";
import { siteExtensions } from "@/lib/site-extensions";
import { countEmailsInFlight, getUsage } from "@/lib/usage";
import Campaign from "@/models/Campaign";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Segment from "@/models/Segment";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { user, account } = view;
	if (!isValidObjectId(id)) notFound();

	const campaign = await Campaign.findOne(scoped(account, { _id: id })).lean();
	if (!campaign) notFound();
	openNewsletter(view, campaign.newsletterId, `/campaigns/${id}`);
	const stored = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	if (!stored) notFound();
	// The previews and the checks show the address its emails print.
	const newsletter = { ...stored, postalAddress: getPostalAddress(stored, siteExtensions.defaultPostalAddress) };
	const [plan, ai] = await Promise.all([getPlanState(account), getAiBinding()]);
	const isAiEnabled = Boolean(ai) && hasActiveSubscription(account);

	if (!["draft", "scheduled"].includes(campaign.status)) {
		const [providers, remainingCount, links, polls] = await Promise.all([
			getProviderBreakdown(campaign),
			countRemaining(campaign),
			listCampaignLinks(campaign),
			getCampaignPolls(account, campaign),
		]);
		const clickMapHtml = links.length > 0 ? await getClickMapHtml(campaign, newsletter, links) : null;
		const resendCounts = canResend(campaign) ? await countResendTargets(campaign) : null;
		// Only a next step needs them, for what its dialog says.
		const [volumes, newContacts] =
			remainingCount > 0 ? await Promise.all([getSendVolumes(account), countNewContacts(account, newsletter._id)]) : [];
		return (
			<CampaignReport
				campaign={serialize(campaign)}
				newsletter={serialize(newsletter)}
				providers={providers}
				links={links.map(({ index, url, clicks, uniqueClicks }) => ({ index, url, clicks, uniqueClicks }))}
				clickMapHtml={clickMapHtml}
				resendCounts={resendCounts}
				remainingCount={remainingCount}
				emailsLeft={plan.emailsLeft}
				isBlocked={isBlocked(account)}
				pace={getPace(account, volumes)}
				newContacts={newContacts}
				polls={polls}
				isAiEnabled={isAiEnabled}
			/>
		);
	}

	const [audienceCount, paidCount, sender, sendTimes, volumes, newContacts, fields, segments, { snippets }] = await Promise.all([
		countCampaignAudience(campaign),
		countCampaignAudience(campaign, { audience: "paid" }),
		loadSender(account, newsletter),
		getSendTimes(campaign),
		getSendVolumes(account),
		countNewContacts(account, newsletter._id),
		listCustomFields(account, newsletter._id),
		Segment.find(scoped(account, { newsletterId: newsletter._id })).sort({ name: 1 }).select({ name: 1 }).lean(),
		runAction("list_snippets", { account, user, via: "dashboard", input: { newsletter: String(newsletter._id) } }),
	]);

	return (
		<FormCampaign
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			audienceCount={audienceCount}
			paidCount={paidCount}
			senderProblem={sender.problem ?? null}
			isSendingEnabled={isSendingEnabled()}
			testEmail={user.email}
			sendTimes={sendTimes}
			archiveUrlBase={newsletter.archiveEnabled ? getArchiveUrls(newsletter).absolutePost("") : null}
			planProblem={plan.problem}
			emailsLeft={plan.emailsLeft}
			pace={getPace(account, volumes)}
			newContacts={newContacts}
			fields={fields.map(({ key, label, type }) => ({ key, label, type }))}
			segments={segments.map(({ _id, name }) => ({ id: String(_id), name }))}
			isAiEnabled={isAiEnabled}
			hasStockPhotos={Boolean(getUnsplashKey())}
			snippets={snippets.map(({ name, content }) => ({ name, content }))}
		/>
	);
}

// What the send dialogs need: emails left after the sends already going out (null: no limit), and what
// blocks any send. Without a plan, the send buttons open the paywall instead.
async function getPlanState(account) {
	if (!hasActiveSubscription(account)) return { emailsLeft: null, problem: null };
	const [usage, inFlight] = await Promise.all([getUsage(account), countEmailsInFlight(account._id)]);
	const accountProblem = getAccountSendProblem(account)?.message ?? null;
	if (usage.emailsLimit === null) return { emailsLeft: null, problem: accountProblem };
	const emailsLeft = Math.max(0, usage.emailsLimit + usage.extraEmailsLimit - usage.emailsSent - inFlight);
	const problem =
		accountProblem ??
		(usage.subscribers > usage.subscribersLimit
			? "Over your plan's subscriber limit"
			: emailsLeft === 0
				? "This month's emails are used up"
				: null);
	return { emailsLeft, problem };
}

// A newsletter's first issue borrows the times the account's other newsletters go out.
async function getSendTimes(campaign) {
	const { accountId } = campaign;
	const own = await Campaign.aggregate(
		sendTimesPipeline({ accountId, newsletterId: campaign.newsletterId, excludeId: campaign._id })
	);
	const rows = own.length > 0 ? own : await Campaign.aggregate(sendTimesPipeline({ accountId, excludeId: campaign._id }));
	return {
		history: rows.map(({ at }) => at.toISOString()),
		taken: own.filter(({ status }) => status === "scheduled").map(({ at }) => at.toISOString()),
	};
}

// Only a send capped to the most engaged has a next step. Close enough for the dialog: contacts who
// left after receiving it make this a little low, and the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit || campaign.abTest?.status === "testing") return 0;
	const active = await countCampaignAudience(campaign);
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}

// The polls the issue has, with their results, through get_poll as the API reads them.
async function getCampaignPolls(account, campaign) {
	const ids = [...new Set(findPolls(campaign.format === "rich" ? campaign.html : "").map(({ id }) => id))];
	const results = await Promise.all(ids.map((id) => runAction("get_poll", { account, input: { id }, via: "dashboard" }).catch(() => null)));
	return results.filter(Boolean);
}

// A sent campaign can be resent once, unless it is a resend or its subject line test is still running.
function canResend(campaign) {
	return campaign.status === "sent" && !campaign.resentAs && !isResend(campaign) && campaign.abTest?.status !== "testing";
}

async function countResendTargets(campaign) {
	const [unopened, unclicked] = await Promise.all(
		["unopened", "unclicked"].map((to) => countResendAudience({ accountId: campaign.accountId, resend: { of: campaign._id, to } }))
	);
	return { unopened, unclicked };
}

async function getProviderBreakdown(campaign) {
	const rows = await Message.aggregate([
		{ $match: { accountId: campaign.accountId, campaignId: campaign._id, kind: "campaign" } },
		{ $group: { _id: { $ifNull: ["$provider", "other"] }, ...MESSAGE_STATS_GROUP } },
		{ $sort: { sent: -1 } },
	]);
	return rows.filter(({ sent }) => sent > 0).map(({ _id, ...row }) => ({ provider: _id, ...row }));
}
