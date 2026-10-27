import CampaignCollaboration from "@/models/CampaignCollaboration";
import EditorThread from "@/models/EditorThread";
import { purgeCollaborationRooms } from "@/lib/collaboration-storage";
import ReaderRetention from "@/models/ReaderRetention";
import CancellationResponse from "@/models/CancellationResponse";
import SponsorshipAsset from "@/models/SponsorshipAsset";
import SponsorshipPlacement from "@/models/SponsorshipPlacement";
import SponsorshipSlot from "@/models/SponsorshipSlot";
import SponsorshipBooking from "@/models/SponsorshipBooking";
import GroupSubscription from "@/models/GroupSubscription";
import SubscriptionFinancial from "@/models/SubscriptionFinancial";
import SubscriptionChange from "@/models/SubscriptionChange";
import SubscriptionInvoice from "@/models/SubscriptionInvoice";
import CreatorConversation from "@/models/CreatorConversation";
import CreatorMessage from "@/models/CreatorMessage";
import "server-only";
import GiftLink from "@/models/GiftLink";
import MeteredRead from "@/models/MeteredRead";
import IssueTranslation from "@/models/IssueTranslation";
import Reply from "@/models/Reply";
import TeamSeat from "@/models/TeamSeat";
import BootstrapRun from "@/models/BootstrapRun";
import ImportedSubscription from "@/models/ImportedSubscription";
import { removeAccountExportFiles } from "@/lib/account-export";
import { scoped } from "@/lib/account-scope";
import { publishPurge } from "@/lib/account-deletion";
import { isPaidStatus } from "@/lib/account-state";
import { findUser } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { revalidateArchive } from "@/lib/archive-data";
import { removeAccountAudioFiles } from "@/lib/audio-storage";
import { deleteUser } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { markPurged, recordDeletion } from "@/lib/deletion-records";
import { BULK_LIMITS } from "@/lib/docdb/model";
import { releaseDomains } from "@/lib/domains";
import { deleteImages, invalidateAccountImages } from "@/lib/image-storage";
import { disconnectAllApps } from "@/lib/oauth-apps";
import { removeAccountImportFiles } from "@/lib/post-import";
import { deletePrivateFiles } from "@/lib/private-files";
import { isTooEarly } from "@/lib/scheduling";
import { releaseSharedSenders } from "@/lib/shared-sender";
import { removeTenants } from "@/lib/tenants";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import AgentActivity from "@/models/AgentActivity";
import AgentDay from "@/models/AgentDay";
import ApprovalRequest from "@/models/ApprovalRequest";
import AiUsage from "@/models/AiUsage";
import AccountExport from "@/models/AccountExport";
import Alert from "@/models/Alert";
import ApiKey from "@/models/ApiKey";
import AudioUsage from "@/models/AudioUsage";
import AudioVersion from "@/models/AudioVersion";
import Automation from "@/models/Automation";
import BulkRemoval from "@/models/BulkRemoval";
import AutomationEnrollment from "@/models/AutomationEnrollment";
import AutomationWatch from "@/models/AutomationWatch";
import Buyer from "@/models/Buyer";
import Campaign from "@/models/Campaign";
import CampaignVersion from "@/models/CampaignVersion";
import CampaignLink from "@/models/CampaignLink";
import Comment from "@/models/Comment";
import CommentReport from "@/models/CommentReport";
import Contact from "@/models/Contact";
import ContactImport from "@/models/ContactImport";
import CustomField from "@/models/CustomField";
import DeletedContact from "@/models/DeletedContact";
import Event from "@/models/Event";
import Gift from "@/models/Gift";
import ExportFile from "@/models/ExportFile";
import IssueTemplate from "@/models/IssueTemplate";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Order from "@/models/Order";
import Offer from "@/models/Offer";
import PaymentEvent from "@/models/PaymentEvent";
import PollVote from "@/models/PollVote";
import Poll from "@/models/Poll";
import PostImport from "@/models/PostImport";
import ExtraEmailUsage from "@/models/ExtraEmailUsage";
import Pledge from "@/models/Pledge";
import PledgeConversion from "@/models/PledgeConversion";
import FeedCache from "@/models/FeedCache";
import ContentItem from "@/models/ContentItem";
import ContentRevision from "@/models/ContentRevision";
import EditorialBatch from "@/models/EditorialBatch";
import LinkCheck from "@/models/LinkCheck";
import Product from "@/models/Product";
import Referral from "@/models/Referral";
import Recommendation from "@/models/Recommendation";
import Redirect from "@/models/Redirect";
import Survey from "@/models/Survey";
import SurveyResponse from "@/models/SurveyResponse";
import ReferralCode from "@/models/ReferralCode";
import ReferralReward from "@/models/ReferralReward";
import Segment from "@/models/Segment";
import SitePage from "@/models/SitePage";
import Snippet from "@/models/Snippet";
import SeriesPlan from "@/models/SeriesPlan";
import SeriesRun from "@/models/SeriesRun";
import SegmentMember from "@/models/SegmentMember";
import Suppression from "@/models/Suppression";
import Tag from "@/models/Tag";
import Upload from "@/models/Upload";
import Form from "@/models/Form";
import FormDay from "@/models/FormDay";
import WebDay from "@/models/WebDay";
import WebhookDelivery from "@/models/WebhookDelivery";
import WebhookEndpoint from "@/models/WebhookEndpoint";

const RETRY_MS = 24 * 60 * 60 * 1000;
// A job deletes for this long, then publishes the next one for the rest: a Worker request that runs for minutes gets cut
// off, and D1 deletes about a million rows a minute (scripts/bench-d1). PURGE_STEP_MS shortens it in tests.
function getStepMs() {
	return process.env.PURGE_STEP_MS ? Number(process.env.PURGE_STEP_MS) : 20_000;
}
// Everything else the account holds, by its accountId. Newsletters, domains and uploads go after what they have at
// the email provider, in DNS and in storage.
export const CONTENT_MODELS = [
	CampaignCollaboration,
	EditorThread,
	SubscriptionFinancial, SubscriptionChange, SubscriptionInvoice,
	CreatorConversation, CreatorMessage,
	MeteredRead,
	GiftLink,
	IssueTranslation,
	Reply, TeamSeat, BootstrapRun, ImportedSubscription,
	AgentActivity,
	AgentDay,
	ApprovalRequest,
	WebDay,
	FormDay,
	Form,
	WebhookDelivery,
	WebhookEndpoint,
	PollVote,
	Poll,
	SurveyResponse,
	Survey,
	Message,
	Event,
	GroupSubscription,
	ReaderRetention,
	CancellationResponse,
	SponsorshipPlacement,
	SponsorshipSlot,
	SponsorshipBooking,
	Contact,
	ContactImport,
	PostImport,
	Redirect,
	SitePage,
	FeedCache,
	LinkCheck,
	ContentRevision,
	ContentItem,
	EditorialBatch,
	SeriesRun,
	SeriesPlan,
	AudioVersion,
	AudioUsage,
	IssueTemplate,
	Snippet,
	DeletedContact,
	CampaignLink,
	CampaignVersion,
	Campaign,
	Suppression,
	ApiKey,
	Alert,
	ExportFile,
	AccountExport,
	Order,
	Buyer,
	PaymentEvent,
	ExtraEmailUsage,
	Referral,
	ReferralReward,
	ReferralCode,
	Recommendation,
	CommentReport,
	Comment,
	AutomationWatch,
	AutomationEnrollment,
	Automation,
	SegmentMember,
	Segment,
	BulkRemoval,
	PledgeConversion,
	Pledge,
	Offer,
	Gift,
	CustomField,
	Tag,
	AiUsage,
];

// Runs when QStash delivers the job, at the end of the grace period. A job for an account restored since, or deleted
// again later, does nothing. A purge that can't finish tells the admins and tries again the next day.
export async function runPurge({ accountId, purgeAt }) {
	if (!isObjectIdString(String(accountId)) || typeof purgeAt !== "string") return { skipped: "invalid job" };
	await connectDb();
	const account = await Account.findById(accountId).lean();
	if (account?.deletion?.purgeAt?.toISOString() !== purgeAt) return { skipped: "not set to be purged at this time" };
	if (isTooEarly(account.deletion.purgeAt)) {
		await publishPurge({ accountId, purgeAt: account.deletion.purgeAt });
		return { waiting: true };
	}
	if (isCloud() && isPaidStatus(account.subscriptionStatus)) {
		return postpone(account, { reason: "its plan is active again", action: "Cancel it with the billing provider before tomorrow's try." });
	}
	let done;
	try {
		done = await purgeAccount(account, Date.now() + getStepMs());
	} catch (error) {
		return postpone(account, { reason: `the purge stopped: ${error.message}`, action: "Fix what stopped it before tomorrow's try." });
	}
	if (done) return { purged: true };
	await publishPurge({ accountId: account._id, purgeAt: account.deletion.purgeAt, at: new Date() });
	return { continued: true };
}

async function postpone(account, { reason, action }) {
	await sendAlert({
		accountId: null,
		key: `purge-postponed:${account._id}`,
		title: "Account purge postponed",
		detail: `Account ${account._id} was deleted by its owner, but ${reason}. The purge tries again tomorrow.`,
		action,
		path: "/admin",
	});
	await publishPurge({ accountId: account._id, purgeAt: account.deletion.purgeAt, at: new Date(Date.now() + RETRY_MS) });
	return { postponed: reason };
}

// Every step can run again, so a purge that stopped halfway picks up where it was. Once it starts, the account can't
// be restored, and signing in with its email opens a new one. False when the time was up before the content was gone.
async function purgeAccount(account, until) {
	await Account.updateOne({ _id: account._id, "deletion.purgeStartedAt": null }, { $set: { "deletion.purgeStartedAt": new Date() } });
	await deleteOwner(account);
	await removeAccountExportFiles(account);
	await removeAccountImportFiles(account);
	await removeAccountAudioFiles(account._id);
	await purgeCollaborationRooms(account);
	if (!(await deleteContent(account, until))) return false;
	await removeIncomingRecommendations(account);
	await releaseSharedSenders(account);
	await releaseDomains(account);
	await removeTenants(account);
	await deleteUploads(account);
	await deleteProducts(account);
	await deleteSponsorshipAssets(account);
	await Newsletter.deleteMany(scoped(account));
	await markPurged(account._id);
	await Account.deleteOne({ _id: account._id });
	revalidateArchive();
	return true;
}

// Messages and events grow with every send, so a big account's can take minutes: a chunk at a time, while there's time.
async function deleteContent(account, until) {
	for (const Model of CONTENT_MODELS) {
		for (;;) {
			const { deletedCount } = await Model.deleteMany(scoped(account)).setOptions({ limit: BULK_LIMITS.deleteChunk });
			if (deletedCount < BULK_LIMITS.deleteChunk) break;
			if (Date.now() >= until) return false;
		}
	}
	return true;
}

// Other accounts' recommendations of this account's newsletters stay in their lists, removed, with the reason.
async function removeIncomingRecommendations(account) {
	await Recommendation.updateMany(
		{ recommendedAccountId: account._id, status: "active" },
		{ $set: { status: "removed", reason: "This newsletter no longer exists.", removedBy: "system", removedAt: new Date() } }
	).setOptions({ crossAccount: true });
}

async function deleteOwner(account) {
	await disconnectAllApps(account);
	const user = await findUser(account.ownerId);
	if (!user) return;
	await recordDeletion({ account, email: user.email, requestedAt: account.deletion.requestedAt });
	await deleteUser({ id: user._id, email: user.email });
}

// The products' files sit in the private bucket, found by their records, so the records go after the files.
async function deleteProducts(account) {
	const products = await Product.find(scoped(account)).select({ "file.key": 1 }).lean();
	await deletePrivateFiles(products.map(({ file }) => file?.key));
	await Product.deleteMany(scoped(account));
}

async function deleteUploads(account) {
	const uploads = await Upload.find(scoped(account)).select({ url: 1, pathname: 1 }).lean();
	await deleteImages(uploads);
	await invalidateAccountImages(account._id);
	await Upload.deleteMany(scoped(account));
}

async function deleteSponsorshipAssets(account) {
	for (;;) {
		const assets = await SponsorshipAsset.find(scoped(account)).select("_id key").limit(100).lean();
		if (!assets.length) return;
		await deletePrivateFiles(assets.map(asset => asset.key));
		await SponsorshipAsset.deleteMany(scoped(account, { _id: { $in: assets.map(asset => asset._id) } }));
	}
}
