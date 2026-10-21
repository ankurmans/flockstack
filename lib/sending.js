import "server-only";
import { Client } from "@upstash/qstash";
import { BLOCKED_CAMPAIGN_REASON, blockAccount } from "@/lib/account-blocks";
import {
	ACCESS_FIELDS,
	ERROR_CODES,
	codedError,
	getAccountSendProblem,
	getPlanLimitProblem,
	getWelcomePauseNotice,
	hasActiveSubscription,
	isBlocked,
} from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { AB_TEST, buildVariants, createVariantPicker, getTestSize, getVariantContent, hasAbTest } from "@/lib/ab-test-rules";
import { getLinkBaseUrl } from "@/lib/archive-hosts";
import { assignArchiveSlug } from "@/lib/archive-slugs";
import { buildAudienceQuery } from "@/lib/audience";
import {
	CLEANUP_FIELDS,
	addToPreview,
	emptyPreview,
	getCleanupSettings,
	splitAudience,
	summarizePreview,
} from "@/lib/cleanup";
import { getSendVolumes } from "@/lib/campaign-queries";
import { FIRST_SEND, LIMITS, getAppUrl, isCloud, isSendingEnabled } from "@/lib/config";
import { getConfirmUrl } from "@/lib/confirmation";
import { getConfirmationContent } from "@/lib/confirmation-content";
import { connectDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email-provider";
import { SEND_OUTCOMES } from "@/lib/email-provider/outcomes";
import { recordExtraEmails } from "@/lib/extra-emails";
import { hasFeedBlocks, resolveFeedBlocks } from "@/lib/feed-resolve";
import { getFirstSendProblem, getFirstSendSlice } from "@/lib/first-send";
import { getFirstCampaignsProblem, showsSentWithLink } from "@/lib/free-plan";
import { getRateLimits } from "@/lib/rate-levels";
import { UNDELIVERABLE_MESSAGE, findGloballySuppressed, markUndeliverable } from "@/lib/global-suppressions";
import { getKeepUrl } from "@/lib/last-chance";
import { saveCampaignLinks } from "@/lib/link-clicks";
import { countResendAudience, isResend, walkResendContacts } from "@/lib/resends";
import { getLastChanceContent } from "@/lib/last-chance-content";
import { getNewsletterPagePath } from "@/lib/newsletters";
import { isInPaidTiers, isPaidContact } from "@/lib/tiers";
import { getAccountLimits, getExtraEmailsLimit, isOnFreeTier } from "@/lib/plans";
import { mailboxProvider } from "@/lib/providers";
import { getRewardEmail } from "@/lib/referral-content";
import { hasRecommendationsTag } from "@/lib/recommendation-tags";
import { getEmailRecommendations } from "@/lib/recommendations";
import { getReferralPageUrl } from "@/lib/referral-links";
import { resolveCampaignSegment, resolveCampaignSegmentFilter } from "@/lib/segments";
import { waitForSendSlot } from "@/lib/send-rate";
import { SEND_BATCH_SIZE, getBatchStarts, getSendHours, getSpreadEnd, getWarmupDay } from "@/lib/send-spread";
import { createSenderCache, loadSender } from "@/lib/sender";
import {
	CAMPAIGN_MESSAGE_KINDS,
	MAX_BATCH_MESSAGES,
	MAX_CONSECUTIVE_FAILURES,
	TEST_CONTACT_ID,
	buildRecipientEmail,
	chunk,
	getCampaignRateProblem,
	getCampaignStatsPath,
	getFeedbackId,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWebPublishProblem,
	getWelcomeContent,
} from "@/lib/sending-rules";
import { blockAccountForHold } from "@/lib/tenant-events";
import { ensureTenant } from "@/lib/tenants";
import {
	addEmailsSent,
	claimPlanEmails,
	claimWelcomePausedNotice,
	countActiveContacts,
	countEmailsInFlight,
	countExtraSent,
	rollUsagePeriod,
} from "@/lib/usage";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { emitCampaignSent } from "@/lib/webhooks";
import Account from "@/models/Account";
import Automation from "@/models/Automation";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Suppression from "@/models/Suppression";

export { buildRecipientEmail } from "@/lib/sending-rules";

const QUEUEABLE_STATUSES = ["draft", "scheduled", "paused"];
const WAITING_STATUSES = ["queued", "held"];
const FIRST_SEND_PAUSE_CODE = "first_send_slice";
const RATES_PAUSE_CODE = "high_rates";
// Resuming from one of these pauses is the owner accepting the rates: only the block level stops the send then.
const RATE_PAUSE_CODES = new Set([FIRST_SEND_PAUSE_CODE, RATES_PAUSE_CODE]);
const INSERT_CHUNK_SIZE = 1000;
const PUBLISH_CHUNK_SIZE = 100;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WELCOME_WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_KINDS = ["welcome", "confirmation", "referral"];
// They take room in the plan's month before they go out. Confirmation emails always go out, so signups never break.
// An automation's emails are like a campaign's: they wait, and go out later, when the plan has room.
const PLAN_KINDS = new Set([...CAMPAIGN_MESSAGE_KINDS, "welcome", "referral", "automation"]);
const WELCOME_PAUSED_REASON = "This month's emails are used up";
const NOT_PAID_REASON = "No longer a paid subscriber";
// Their links have to work, so they go out clean: no tracking pixel or redirect.
const UNTRACKED_KINDS = new Set(["confirmation", "last-chance", "order", "comment"]);
// Signing up again resends the confirmation, but a script can't make us mail an address over and over.
const MAX_CONFIRMATIONS_PER_CONTACT = 3;
// When the provider is full and says nothing more precise.
const DEFAULT_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 3600;
// Why a send stopped halfway; it resumes from the campaign's page once the reason is gone.
const PAUSE_REASONS = {
	[ERROR_CODES.subscriptionRequired]: "the account is being deleted",
	[ERROR_CODES.accountBlocked]: BLOCKED_CAMPAIGN_REASON,
	[ERROR_CODES.planLimitEmails]: "this month's emails are used up",
};
// The provider refusing FlockStack's own setup, not the account's: a key, a cluster, a credential or its approval.
const SETUP_OUTCOMES = new Set([SEND_OUTCOMES.misconfigured, SEND_OUTCOMES.approvalPending]);

let qstash;

// Codes from lib/actions/errors.js, so the API and MCP can tell these apart.
function fail(code, message) {
	return codedError({ code, message });
}

function assertSendingEnabled() {
	if (!isSendingEnabled()) throw fail("sending_disabled", "Sending is off");
}

export function getQStash() {
	if (!process.env.QSTASH_TOKEN) throw fail("unavailable", "QStash is not configured (QSTASH_TOKEN)");
	qstash ??= new Client({ token: process.env.QSTASH_TOKEN });
	return qstash;
}

function formatError(error) {
	return String(error?.message || error).slice(0, 500);
}

// QStash refusing a job (its token, its quota) stops every send, schedule and purge until it's fixed.
async function publishWith(publish) {
	const client = getQStash();
	try {
		return await publish(client);
	} catch (error) {
		await sendAlert({
			accountId: null,
			key: "qstash-refused",
			title: "QStash refused a job",
			detail: `${formatError(error)}.`,
			action: "Sends, schedules and purges can't start until it's fixed: check QSTASH_TOKEN and the plan's quota.",
			link: "https://console.upstash.com/qstash",
		});
		throw error;
	}
}

export function publishJob(request) {
	return publishWith((client) => client.publishJSON(request));
}

// No account can fix these, nor SES suspending the whole AWS account, so the admins hear of them.
async function alertSendRefused(accountId, error) {
	if (!SETUP_OUTCOMES.has(error?.outcome) && error?.name !== "AccountSuspendedException") return;
	const provider = getEmailProvider();
	await sendAlert({
		accountId: null,
		key: `send-refused:${error.outcome ?? error.name}`,
		title: `${provider.name} refuses FlockStack's sends`,
		detail: `Account ${accountId}: ${formatError(error)}.`,
		action:
			error.outcome === SEND_OUTCOMES.approvalPending
				? `Readers' emails are refused until ${provider.name} approves the team.`
				: `Campaigns pause and signup emails fail until it's fixed at ${provider.name}: its key, clusters or credentials.`,
		...(provider.id === "postshiba" && { link: "https://app.postshiba.com" }),
	});
}

// A from address the account can't use, or a check the email itself fails (lib/sending-rules.js).
function sendProblemError(problem, sender) {
	return fail(problem === sender?.problem ? "sender_not_allowed" : "send_check_failed", problem);
}

function senderNotAllowed(problem) {
	return Object.assign(new Error(problem), { name: "SenderNotAllowed" });
}

// Each batch or test reads the account's tenant once, creating it if the plan started without one.
function createTenantLoader(account) {
	let tenant;
	return () => (tenant ??= ensureTenant(account));
}

// sender: the from address checked against the account's domains (lib/sender.js), for every kind of email.
// The email goes through the account's tenant at the email provider (lib/email-provider).
async function deliver({ message, content, newsletter, contact, sender, getTenant, transactionalReason = "", sentWith = false }) {
	if (sender.problem) throw senderNotAllowed(sender.problem);
	const provider = getEmailProvider();
	const tenant = await getTenant();
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const baseUrl = getLinkBaseUrl(newsletter);
	const createdAt = new Date(message.createdAt ?? Date.now()).getTime();
	const hasBlock = hasRecommendationsTag(content?.html) || hasRecommendationsTag(content?.markdown);
	const email = buildRecipientEmail({
		campaign: content,
		newsletter,
		contact,
		sender,
		recommendations: hasBlock ? await getEmailRecommendations(newsletter) : null,
		messageId: UNTRACKED_KINDS.has(message.kind) ? null : message._id,
		confirmUrl: message.kind === "confirmation" ? getConfirmUrl(reference, baseUrl, createdAt) : "",
		keepUrl: message.kind === "last-chance" ? getKeepUrl(reference, baseUrl, createdAt) : "",
		transactionalReason,
		sentWith: sentWith && !UNTRACKED_KINDS.has(message.kind),
	});
	const feedbackId = getFeedbackId({
		campaignId: message.campaignId ?? message.automationId,
		newsletterId: newsletter._id,
		accountId: message.accountId,
		kind: message.kind,
	});
	await waitForSendSlot(provider.getSendLane(message.kind));
	const { providerMessageId } = await provider.sendEmail({ tenant, message, email, feedbackId });
	return { providerMessageId, sentAt: new Date() };
}

// A reward that was deleted since its email was queued has nothing to announce.
function getReferralMessageContent({ newsletter, contact, message }) {
	const reward = newsletter?.referral?.rewards?.find(({ id }) => id === message.referralRewardId);
	if (!reward) return null;
	const pageUrl = getReferralPageUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter);
	return getRewardEmail({ newsletter, reward, count: contact.referral?.count ?? reward.referrals, pageUrl });
}

// An automation's email is one of its steps, which has the fields of a campaign's content.
function getMessageContent({ kind, newsletter, campaign, automation, stepId, message, contact }) {
	if (kind === "automation") return automation?.steps?.find((step) => step.id === stepId && step.type === "email") ?? null;
	if (kind === "welcome") return getWelcomeContent(newsletter);
	if (kind === "referral") return getReferralMessageContent({ newsletter, contact, message });
	if (kind === "confirmation") return newsletter ? getReminderContent(getConfirmationContent(newsletter), message.reminder) : null;
	if (kind === "last-chance") return newsletter ? getLastChanceContent(newsletter) : null;
	return campaign && getVariantContent(campaign, message.variant);
}

function getReminderContent(content, isReminder) {
	return isReminder ? { ...content, subject: `Reminder: ${content.subject}` } : content;
}

// Welcome and confirmation emails share one cap per newsletter, so a signup flood can't burn its sending
// domain's reputation, and a flood on one newsletter doesn't hold up the others' signup emails. Welcome emails
// skipped for want of room never went out, so they don't hold up confirmation emails either.
function countRecentSignupEmails(newsletter) {
	return Message.countDocuments({
		accountId: newsletter.accountId,
		kind: { $in: SIGNUP_KINDS },
		newsletterId: newsletter._id,
		status: { $ne: "skipped" },
		createdAt: { $gte: new Date(Date.now() - WELCOME_WINDOW_MS) },
	});
}

async function alertSignupCap(newsletter) {
	await sendAlert({
		accountId: newsletter.accountId,
		key: `welcome-cap:${newsletter.slug}`,
		title: "Signup emails capped",
		detail: `Over ${LIMITS.welcomeEmailsPer10Minutes} welcome and confirmation emails for ${newsletter.name} in 10 minutes. New signups get none until it slows down.`,
		path: getNewsletterPagePath(newsletter._id, "/contacts"),
	});
}

async function findByIds(Model, accountId, ids) {
	const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
	if (uniqueIds.length === 0) return new Map();
	const documents = await Model.find({ accountId, _id: { $in: uniqueIds } }).lean();
	return new Map(documents.map((document) => [String(document._id), document]));
}

async function findAccount(accountId) {
	const account = isObjectIdString(String(accountId)) ? await Account.findById(accountId).lean() : null;
	if (!account) throw fail("not_found", "Account not found");
	return account;
}

// isQuiet: the account's block that comes with it already tells the owner.
async function pauseCampaign({ accountId, campaignId, reason, code, isQuiet = false }) {
	const { modifiedCount } = await Campaign.updateOne(
		{ accountId, _id: campaignId, status: "sending" },
		{ $set: { status: "paused", pauseReason: reason, ...(code && { pauseCode: code }) }, ...(!code && { $unset: { pauseCode: 1 } }) }
	);
	if (!modifiedCount || isQuiet) return;
	await sendAlert({
		accountId,
		key: `campaign-paused-${campaignId}`,
		title: "Campaign paused",
		detail: reason,
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 1,
	});
}

// Gmail's spam rate for the account between the pause and block levels (lib/postmaster.js): its sends pause as a send
// over the pause level does, and one its owner resumed from such a pause goes on until the block level.
export async function pauseSendingCampaigns(accountId, reason) {
	await connectDb();
	const campaigns = await Campaign.find({ accountId, status: "sending", ratesAcceptedAt: null }).select({ _id: 1 }).lean();
	for (const { _id } of campaigns) await pauseCampaign({ accountId, campaignId: _id, reason, code: RATES_PAUSE_CODE });
	return campaigns.map(({ _id }) => String(_id));
}

// The levels the account's sends are judged at: tighter on the Free plan (lib/rate-levels.js).
async function loadRateLimits(accountId, account) {
	return getRateLimits(account ?? (await Account.findById(accountId).select({ subscriptionStatus: 1, plan: 1, comp: 1 }).lean()));
}

// Over the block level a send blocks its whole account, which pauses it with the others: "block". Over the pause
// level it pauses alone and its owner is emailed: "pause", unless its owner resumed it from such a pause already
// (ratesAcceptedAt), and then only the block level stops it.
async function stopIfUnhealthy(accountId, campaignId, account = null) {
	const campaign = await Campaign.findOne({ accountId, _id: campaignId, status: "sending" })
		.select("stats lastChance ratesAcceptedAt")
		.lean();
	const problem = campaign ? getCampaignRateProblem(campaign.stats, campaign.lastChance, await loadRateLimits(accountId, account)) : null;
	if (!problem || (problem.level === "pause" && campaign.ratesAcceptedAt)) return null;
	if (problem.level === "block") {
		await blockAccount(accountId, { reason: problem.reason, by: "campaign" });
		await pauseCampaign({ accountId, campaignId, reason: BLOCKED_CAMPAIGN_REASON, code: ERROR_CODES.accountBlocked, isQuiet: true });
	} else {
		await pauseCampaign({ accountId, campaignId, reason: problem.reason, code: RATES_PAUSE_CODE });
	}
	return problem.level;
}

async function settleCampaign(accountId, campaignId) {
	if (await stopIfUnhealthy(accountId, campaignId)) return;
	if (await Message.exists({ accountId, campaignId, kind: { $in: CAMPAIGN_MESSAGE_KINDS }, status: { $in: WAITING_STATUSES } })) return;
	// A campaign sent in steps keeps the date of its first step.
	const sent = await Campaign.findOneAndUpdate(
		{ accountId, _id: campaignId, status: "sending" },
		{ $set: { status: "sent", finishedAt: new Date() }, $min: { sentAt: new Date() }, $unset: { sendingUntil: 1 } },
		{ returnDocument: "after" }
	).lean();
	if (sent) await emitCampaignSent(sent);
}

async function insertIgnoringDuplicates(messages) {
	if (messages.length === 0) return;
	try {
		await Message.insertMany(messages, { ordered: false });
	} catch (error) {
		// Mongoose copies the driver's WriteErrors, which keeps the code on `err`.
		const codes = (error?.writeErrors ?? []).map(({ err, code }) => err?.code ?? code);
		const isOnlyDuplicates =
			codes.length > 0 ? codes.every((code) => code === 11000) : error?.code === 11000;
		if (!isOnlyDuplicates) throw error;
	}
}

async function* inChunks(items, size) {
	let pending = [];
	for await (const item of items) {
		pending.push(item);
		if (pending.length === size) {
			yield pending;
			pending = [];
		}
	}
	if (pending.length > 0) yield pending;
}

// pickVariant: the subject line each issue gets in a test slice (lib/ab-test-rules.js).
function toMessages(campaign, kind, contacts, pickVariant = () => undefined) {
	return contacts.map((contact) => {
		const variant = kind === "campaign" ? pickVariant() : undefined;
		return {
			kind,
			accountId: campaign.accountId,
			campaignId: campaign._id,
			newsletterId: campaign.newsletterId,
			contactId: contact._id,
			email: contact.email,
			provider: mailboxProvider(contact.email),
			...(kind === "campaign" && !contact.lastSentAt && { firstSend: true }),
			...(variant !== undefined && { variant }),
		};
	});
}

// Contacts this campaign already reached: an earlier step, or an attempt that stopped halfway.
async function findPreviousMessages(campaign) {
	const messages = await Message.find({
		accountId: campaign.accountId,
		campaignId: campaign._id,
		kind: { $in: CAMPAIGN_MESSAGE_KINDS },
	})
		.select({ _id: 0, contactId: 1, kind: 1 })
		.lean();
	return new Map(messages.map(({ contactId, kind }) => [String(contactId), kind]));
}

function findSuppressedEmails(accountId) {
	return Suppression.distinct("email", { accountId });
}

// Active, unsuppressed contacts, most engaged first. With the list cleanup on, the limit counts issue
// recipients only, so it's applied while walking (lib/cleanup.js splitAudience).
async function findAudience({ campaign, settings, audienceLimit }) {
	const { filter, sort, limit } = buildAudienceQuery({
		accountId: campaign.accountId,
		newsletterId: campaign.newsletterId,
		suppressedEmails: await findSuppressedEmails(campaign.accountId),
		audienceLimit,
		audience: campaign.audience,
		audienceTiers: campaign.audienceTiers,
		segmentFilter: await resolveCampaignSegmentFilter(campaign),
	});
	const query = Contact.find(filter)
		.sort(sort)
		.select(settings.enabled ? { ...CLEANUP_FIELDS, lastSentAt: 1 } : { email: 1, lastSentAt: 1 })
		.lean();
	if (limit && !settings.enabled) query.limit(limit);
	const previous = settings.enabled ? await findPreviousMessages(campaign) : new Map();
	return { contacts: query.cursor(), limit, previous };
}

async function makeDormant(campaign, contacts) {
	if (contacts.length === 0) return;
	// A sign of life since the walk read them sets ignoredIssues back to 0: those contacts stay.
	const { modifiedCount } = await Contact.updateMany(
		{
			accountId: campaign.accountId,
			_id: { $in: contacts.map(({ _id }) => _id) },
			status: "active",
			ignoredIssues: { $gt: 0 },
		},
		{ $set: { status: "dormant" } }
	);
	if (modifiedCount > 0) {
		await Campaign.updateOne(
			{ accountId: campaign.accountId, _id: campaign._id },
			{ $inc: { "lastChance.dormant": modifiedCount } }
		);
	}
}

// A resend's readers get the issue, never the list cleanup's email: they had the first send's turn at it.
async function insertResendMessages(campaign) {
	const { filter } = buildAudienceQuery({
		accountId: campaign.accountId,
		newsletterId: campaign.newsletterId,
		suppressedEmails: await findSuppressedEmails(campaign.accountId),
		audience: campaign.audience,
		audienceTiers: campaign.audienceTiers,
		segmentFilter: await resolveCampaignSegmentFilter(campaign),
	});
	for await (const contacts of walkResendContacts(campaign, filter, { email: 1, lastSentAt: 1 })) {
		await insertIgnoringDuplicates(toMessages(campaign, "campaign", contacts));
	}
}

async function insertCampaignMessages(campaign, newsletter) {
	if (isResend(campaign)) return insertResendMessages(campaign);
	const settings = getCleanupSettings(newsletter);
	const { contacts, limit, previous } = await findAudience({ campaign, settings, audienceLimit: campaign.audienceLimit });
	const now = Date.now();
	const pickVariant = createVariantPicker(campaign);
	let remaining = limit ?? Infinity;
	for await (const group of inChunks(contacts, INSERT_CHUNK_SIZE)) {
		const split = splitAudience(group, { settings, limit: remaining, previous, now });
		await insertIgnoringDuplicates(toMessages(campaign, "campaign", split.issue, pickVariant));
		await insertIgnoringDuplicates(toMessages(campaign, "last-chance", split.lastChance));
		await makeDormant(campaign, split.dormant);
		remaining -= split.issue.length + split.received;
		if (remaining <= 0) break;
	}
}

// What the list cleanup would do at this send: one read-only walk over the whole list.
async function walkCleanupPreview(campaign, settings) {
	const { contacts, previous } = await findAudience({ campaign, settings });
	const preview = emptyPreview();
	const now = Date.now();
	for await (const group of inChunks(contacts, INSERT_CHUNK_SIZE)) addToPreview(preview, group, { settings, previous, now });
	return preview;
}

export async function getCleanupPreview({ accountId, campaignId }) {
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");
	await connectDb();
	const campaign = await Campaign.findOne({ accountId, _id: campaignId })
		.select({ accountId: 1, newsletterId: 1, audience: 1, audienceTiers: 1, segmentId: 1, segmentSnapshot: 1 })
		.lean();
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await Newsletter.findOne({ accountId, _id: campaign.newsletterId }).select({ slug: 1, cleanup: 1 }).lean();
	const settings = getCleanupSettings(newsletter);
	if (!settings.enabled) return { enabled: false };
	return { enabled: true, ...(await walkCleanupPreview(campaign, settings)) };
}

// Active contacts a send of the campaign would reach, before the list cleanup, within its limit.
async function countAudience(campaign) {
	const { filter, limit } = buildAudienceQuery({
		accountId: campaign.accountId,
		newsletterId: campaign.newsletterId,
		suppressedEmails: await findSuppressedEmails(campaign.accountId),
		audienceLimit: campaign.audienceLimit,
		audience: campaign.audience,
		audienceTiers: campaign.audienceTiers,
		segmentFilter: await resolveCampaignSegmentFilter(campaign),
	});
	return Math.min(limit ?? Infinity, await Contact.countDocuments(filter));
}

// The emails a send would add, counted before anything is written: the list cleanup makes contacts
// dormant as the send walks the list, so the plan check can't wait for that walk.
async function countNewEmails({ campaign, newsletter, audienceLimit, issuesSoFar = 0 }) {
	if (isResend(campaign)) return Math.max(0, (await countResendAudience(campaign)) - issuesSoFar);
	const settings = getCleanupSettings(newsletter);
	if (settings.enabled) {
		const { issue, lastChance } = summarizePreview(await walkCleanupPreview(campaign, settings), audienceLimit);
		return Math.max(0, issue - issuesSoFar) + lastChance;
	}
	const { filter, limit } = buildAudienceQuery({
		accountId: campaign.accountId,
		newsletterId: campaign.newsletterId,
		suppressedEmails: await findSuppressedEmails(campaign.accountId),
		audienceLimit,
		audience: campaign.audience,
		audienceTiers: campaign.audienceTiers,
		segmentFilter: await resolveCampaignSegmentFilter(campaign),
	});
	const audience = await Contact.countDocuments(filter);
	return Math.max(0, Math.min(limit ?? Infinity, audience) - issuesSoFar);
}

function countQueuedEmails(campaign) {
	return Message.countDocuments({
		accountId: campaign.accountId,
		campaignId: campaign._id,
		kind: { $in: CAMPAIGN_MESSAGE_KINDS },
		status: { $in: WAITING_STATUSES },
	});
}

function publishFirstSendCheck(campaign, at) {
	return publishJob({
		url: `${getAppUrl()}/api/jobs/check-first-send`,
		body: { accountId: String(campaign.accountId), campaignId: String(campaign._id) },
		notBefore: Math.floor(at.getTime() / 1000),
	});
}

// The step that picks a subject line test's winner and sends it to the rest (lib/ab-tests.js).
export function publishAbTestPick(campaign, at) {
	return publishJob({
		url: `${getAppUrl()}/api/jobs/pick-ab-winner`,
		body: { accountId: String(campaign.accountId), campaignId: String(campaign._id) },
		notBefore: Math.floor(at.getTime() / 1000),
	});
}

// A send with a subject line test starts with its test slice: the share of the audience it tests on, each subject in
// turn. The send's own limit waits for the winner's step.
async function startAbTest(campaign) {
	const { testPercent = AB_TEST.percent.default, waitMinutes = AB_TEST.waitMinutes.default, metric = "clicks" } = campaign.abTest;
	const variants = buildVariants(campaign, campaign.abTest.variants.slice(1));
	const testLimit = getTestSize(await countAudience(campaign), { testPercent, variants });
	const abTest = {
		variants,
		testPercent,
		waitMinutes,
		metric,
		status: "testing",
		...(campaign.audienceLimit && { audienceLimit: campaign.audienceLimit }),
	};
	return { ...campaign, audienceLimit: Math.max(testLimit, 1), abTest };
}

// Past the first slice, never-mailed contacts wait as "held" until checkFirstSend lets them go. In a spread send,
// what goes now takes its share of the spread's hours (publishMs), and the check comes 3 hours after it.
async function holdFirstSendRest(campaign, spreadMs) {
	const filter = { accountId: campaign.accountId, campaignId: campaign._id, kind: "campaign", status: "queued", firstSend: true };
	const slice = getFirstSendSlice(await Message.countDocuments(filter));
	if (!slice) return null;
	const rest = (await Message.find(filter).sort({ _id: 1 }).skip(slice).select({ _id: 1 }).lean()).map(({ _id }) => _id);
	for (const ids of chunk(rest, INSERT_CHUNK_SIZE)) {
		await Message.updateMany({ accountId: campaign.accountId, _id: { $in: ids }, status: "queued" }, { $set: { status: "held" } });
	}
	const queued = await Message.countDocuments({
		accountId: campaign.accountId,
		campaignId: campaign._id,
		kind: { $in: CAMPAIGN_MESSAGE_KINDS },
		status: "queued",
	});
	const publishMs = Math.round((spreadMs * queued) / (queued + rest.length));
	const checkAt = new Date(Date.now() + publishMs + FIRST_SEND.waitMinutes * MINUTE_MS);
	const firstSend = { slice, held: rest.length, checkAt, ...(spreadMs && { restHours: (spreadMs - publishMs) / HOUR_MS }) };
	await Campaign.updateOne({ accountId: campaign.accountId, _id: campaign._id }, { $set: { firstSend } });
	await publishFirstSendCheck(campaign, checkAt);
	return { slice, held: rest.length, publishMs };
}

// The held rest of a spread send takes the rest of its hours. Sends held before restHours was kept take the rest's share
// of the campaign's hours.
function getRestSpreadMs(campaign, held) {
	if (!campaign.sendingUntil || !campaign.spreadHours) return 0;
	if (campaign.firstSend?.restHours !== undefined) return Math.round(campaign.firstSend.restHours * HOUR_MS);
	const total = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return total > 0 ? Math.round((campaign.spreadHours * HOUR_MS * held) / total) : 0;
}

// Resuming a send that held contacts back: a customer resuming after a bad slice sends the rest; any other
// pause checks the slice again first.
async function resumeHeldMessages(campaign) {
	const held = { accountId: campaign.accountId, campaignId: campaign._id, status: "held" };
	if (campaign.pauseCode === FIRST_SEND_PAUSE_CODE) await Message.updateMany(held, { $set: { status: "queued" } });
	else if (await Message.exists(held)) await publishFirstSendCheck(campaign, new Date());
}

function countFirstSendSlice(campaign) {
	return Message.aggregate([
		{ $match: { accountId: campaign.accountId, campaignId: campaign._id, kind: "campaign", firstSend: true, status: { $ne: "held" } } },
		{
			$group: {
				_id: null,
				queued: { $sum: { $cond: [{ $eq: ["$status", "queued"] }, 1, 0] } },
				sent: { $sum: { $cond: [{ $ifNull: ["$sentAt", false] }, 1, 0] } },
				bounced: { $sum: { $cond: [{ $ifNull: ["$bouncedAt", false] }, 1, 0] } },
				complained: { $sum: { $cond: [{ $ifNull: ["$complainedAt", false] }, 1, 0] } },
			},
		},
	]).then(([counts]) => ({ queued: counts?.queued ?? 0, sent: counts?.sent ?? 0, bounced: counts?.bounced ?? 0, complained: counts?.complained ?? 0 }));
}

// Runs when QStash delivers the check: a slice still going out waits a little more; a slice over the block level
// blocks the account, one over the pause level holds the rest until its owner resumes; a good one lets them go.
export async function checkFirstSend({ accountId, campaignId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId))) return { skipped: "invalid job" };
	await connectDb();
	const campaign = await Campaign.findOne({ accountId, _id: campaignId })
		.select("accountId status sendingUntil spreadHours firstSend.restHours stats.recipients lastChance.recipients")
		.lean();
	if (!campaign) return { skipped: "campaign not found" };
	const held = { accountId: campaign.accountId, campaignId: campaign._id, status: "held" };
	if (!(await Message.exists(held))) return { skipped: "nothing held" };
	if (campaign.status !== "sending") return { skipped: `campaign is ${campaign.status}` };

	const slice = await countFirstSendSlice(campaign);
	if (slice.queued > 0) {
		await publishFirstSendCheck(campaign, new Date(Date.now() + FIRST_SEND.recheckMinutes * 60_000));
		return { waiting: true, ...slice };
	}
	const problem = getFirstSendProblem(slice, await loadRateLimits(campaign.accountId));
	if (problem?.level === "block") {
		const reason = `${problem.reason}. The rest of the new contacts weren't sent.`;
		await pauseCampaign({ accountId: campaign.accountId, campaignId: campaign._id, reason, code: FIRST_SEND_PAUSE_CODE, isQuiet: true });
		await blockAccount(campaign.accountId, { reason: problem.reason, by: "slice" });
		return { paused: true, blocked: true, ...slice };
	}
	if (problem) {
		const reason = `${problem.reason}. The rest of the new contacts wait: clean the list of addresses you can't vouch for, then resume to send to them.`;
		await pauseCampaign({ accountId: campaign.accountId, campaignId: campaign._id, reason, code: FIRST_SEND_PAUSE_CODE });
		return { paused: true, ...slice };
	}
	// Only the held ones: batches of a spread send still waiting for their time keep it.
	const ids = (await Message.find(held).sort({ _id: 1 }).select({ _id: 1 }).lean()).map(({ _id }) => _id);
	const { modifiedCount } = await Message.updateMany(held, { $set: { status: "queued" } });
	const restMs = getRestSpreadMs(campaign, ids.length);
	await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id },
		{ $set: { "firstSend.checkedAt": new Date(), ...(restMs && { sendingUntil: new Date(Date.now() + restMs) }) } }
	);
	const batches = await publishBatches(campaign, ids, restMs);
	return { released: modifiedCount, batches, ...slice };
}

// The campaigns the account has sent, for the cap on a Free account's first ones (lib/free-plan.js). Not the one being sent.
function findSentCampaigns(accountId, campaignId) {
	return Campaign.find({ accountId, status: "sent", _id: { $ne: campaignId }, "stats.sent": { $gt: 0 } })
		.sort({ sentAt: -1 })
		.limit(50)
		.select({ stats: 1, sentAt: 1, finishedAt: 1 })
		.lean();
}

// Campaign sends stop when the account can't send or the plan has no room for them. Signups don't. recipients: the emails
// this send adds. total: everyone the campaign would have gone to with it, steps before it included.
async function assertCanSendCampaign(account, recipients, { campaignId, total = recipients } = {}) {
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) throw codedError(accountProblem);
	const current = await rollUsagePeriod(account);
	const [activeContacts, queued] = await Promise.all([
		countActiveContacts(account._id),
		countEmailsInFlight(account._id),
	]);
	const problem = getPlanLimitProblem({
		account: current,
		emailsSent: current.usage?.emailsSent ?? 0,
		queued,
		recipients,
		activeContacts,
	});
	if (problem) throw codedError(problem);
	if (isOnFreeTier(current)) {
		const start = getFirstCampaignsProblem({ account: current, campaigns: await findSentCampaigns(account._id, campaignId), total });
		if (start) throw codedError(start);
	}
}

// Before scheduling. A send that goes out after the month resets only needs the account able to send and
// under its subscriber limit; it's checked in full when it goes out.
export async function checkCampaignSend({ accountId, campaignId, audienceLimit, audience, at }) {
	await connectDb();
	const account = await findAccount(accountId);
	const campaign = await Campaign.findOne({ accountId: account._id, _id: campaignId }).lean();
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await Newsletter.findOne({ accountId: account._id, _id: campaign.newsletterId }).lean();
	const periodEnd = account.usage?.periodEnd;
	const isAfterReset = Boolean(at && periodEnd && at >= new Date(periodEnd));
	const audienceEmails = await countNewEmails({ campaign: audience ? { ...campaign, audience } : campaign, newsletter, audienceLimit });
	await assertCanSendCampaign(account, isAfterReset ? 0 : audienceEmails, { campaignId: campaign._id, total: audienceEmails });
}

function countCampaignMessages(campaign) {
	return Promise.all(
		CAMPAIGN_MESSAGE_KINDS.map((kind) =>
			Message.countDocuments({ accountId: campaign.accountId, campaignId: campaign._id, kind })
		)
	);
}

// In a spread send (lib/send-spread.js) each batch waits for its start time; like every batch, it checks the
// campaign's rates first.
async function publishBatches(campaign, messageIds, spreadMs = 0) {
	const url = `${getAppUrl()}/api/jobs/send-batch`;
	// One batch at a time per account, whatever its number of campaigns, so a large send can't take every
	// slot: other accounts' batches run beside it, and all of them share the SES rate (lib/send-rate.js).
	const flowControl = { key: `account-${campaign.accountId}`, parallelism: 1 };
	const accountId = String(campaign.accountId);
	const batches = chunk(
		messageIds.map((id) => String(id)),
		SEND_BATCH_SIZE
	);
	const starts = getBatchStarts(batches.length, spreadMs);
	const requests = batches.map((ids, index) => ({
		url,
		body: { accountId, messageIds: ids },
		flowControl,
		...(starts[index] && { notBefore: starts[index] }),
	}));

	for (const group of chunk(requests, PUBLISH_CHUNK_SIZE)) await publishWith((client) => client.batchJSON(group));
	return requests.length;
}

// Issues first; last-chance emails go to the least engaged addresses, after everyone else.
async function publishQueuedMessages(campaign, spreadMs = 0) {
	const queued = await Message.find({
		accountId: campaign.accountId,
		campaignId: campaign._id,
		kind: { $in: CAMPAIGN_MESSAGE_KINDS },
		status: "queued",
	})
		.sort({ kind: 1, _id: 1 })
		.select({ _id: 1 })
		.lean();
	return publishBatches(
		campaign,
		queued.map(({ _id }) => _id),
		spreadMs
	);
}

// What a send queued goes out now, over its spread; contacts held back for the first-send check follow once it
// passes. sendingUntil: about when its last batch goes, the check's 3 hours included.
async function publishSend(campaign, spreadMs, { isResuming = false } = {}) {
	if (isResuming) await resumeHeldMessages(campaign);
	const firstSend = isResuming ? null : await holdFirstSendRest(campaign, spreadMs);
	const batches = await publishQueuedMessages(campaign, firstSend ? firstSend.publishMs : spreadMs);
	const isSpread = spreadMs > 0 && (batches > 1 || Boolean(firstSend));
	const endsInMs = spreadMs + (firstSend ? FIRST_SEND.waitMinutes * MINUTE_MS : 0);
	await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id },
		isSpread ? { $set: { sendingUntil: new Date(Date.now() + endsInMs) } } : { $unset: { sendingUntil: 1 } }
	);
	return batches;
}

// What a send adding these emails goes out over (lib/send-spread.js), worked out before it's marked sending, so its own
// emails don't count twice. Self-hosted servers send at full speed.
async function getPaceMs(account, emails) {
	if (!isCloud()) return 0;
	const { proven, recent } = await getSendVolumes(account);
	return getSendHours({ emails, recent, proven, day: getWarmupDay(account) }) * HOUR_MS;
}

// The account's first campaign starts its 30-day warm-up, however small.
async function startWarmup(account) {
	if (!isCloud() || account.spreadUntil) return;
	await Account.updateOne({ _id: account._id, spreadUntil: { $exists: false } }, { $set: { spreadUntil: getSpreadEnd() } });
}

async function loadCampaignSend({ accountId, campaignId }) {
	assertSendingEnabled();
	if (!process.env.QSTASH_TOKEN) throw fail("unavailable", "QStash is not configured (QSTASH_TOKEN)");
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");

	await connectDb();
	const account = await findAccount(accountId);
	const campaign = await Campaign.findOne({ accountId: account._id, _id: campaignId }).lean();
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await Newsletter.findOne({ accountId: account._id, _id: campaign.newsletterId }).lean();
	return { account, campaign, newsletter };
}

// The links clicks are counted on, from the email as it goes out (its page's slug included). Counting them is a
// report's business, never a reason for a send not to start.
async function recordCampaignLinks(campaign, newsletter) {
	try {
		const { archiveSlug } = await Campaign.findOne({ accountId: campaign.accountId, _id: campaign._id }).select({ archiveSlug: 1 }).lean();
		await saveCampaignLinks({ ...campaign, archiveSlug }, newsletter);
	} catch (error) {
		console.error(`[sending] Links of campaign ${campaign._id} not saved:`, error);
	}
}

// A web only issue goes out as a page on the website, sent with no emails.
async function publishOnWeb({ account, campaign, newsletter, feedHtml = {} }) {
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) throw codedError(accountProblem);
	const problem = getWebPublishProblem({ campaign, newsletter });
	if (problem) throw fail("send_check_failed", problem);
	const now = new Date();
	const { modifiedCount } = await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id, status: campaign.status },
		{ $set: { status: "sent", archiveListed: true, startedAt: now, sentAt: now, ...feedHtml }, $unset: { pauseReason: 1, pauseCode: 1, audienceLimit: 1 } }
	);
	if (!modifiedCount) throw fail("conflict", "The campaign changed, refresh and try again");
	await assignArchiveSlug({ campaign, newsletter });
	return { recipients: 0, batches: 0 };
}

// An RSS block (lib/feed-resolve.js) is read once, as the send starts, and replaced by the items themselves in the saved
// issue (the same write that starts the send): every reader gets the same email and the page shows what was sent. A feed
// that can't be read stops the send before anything goes out, and a send that stops for another reason leaves the block
// in the draft to be read again.
async function readFeedBlocks({ account, campaign }) {
	if (campaign.format !== "rich" || !hasFeedBlocks(campaign.html)) return campaign;
	try {
		return { ...campaign, html: (await resolveFeedBlocks(campaign.html, { account })).html };
	} catch (error) {
		throw fail("send_check_failed", `The RSS block's feed couldn't be read: ${formatError(error)}`);
	}
}

// Draft or scheduled: selects the audience. Paused: resumes with the audience it already has.
export async function queueCampaign({ accountId, campaignId }) {
	const loaded = await loadCampaignSend({ accountId, campaignId });
	const { account, newsletter } = loaded;
	if (!QUEUEABLE_STATUSES.includes(loaded.campaign.status)) {
		throw fail("conflict", `Campaign is already ${loaded.campaign.status}`);
	}
	const feeds = loaded.campaign.status === "paused" ? loaded.campaign : await readFeedBlocks({ account, campaign: loaded.campaign });
	const feedHtml = feeds.html === loaded.campaign.html ? {} : { html: feeds.html };
	loaded.campaign = feeds;
	if (loaded.campaign.publishTo === "web" && loaded.campaign.status !== "paused") return publishOnWeb({ ...loaded, feedHtml });
	// The audience is worked out once: the same rules count the send, pick its contacts and stay with the campaign.
	const segment = await resolveCampaignSegment(loaded.campaign);
	const withSegment = segment ? { ...loaded.campaign, segmentSnapshot: segment } : loaded.campaign;
	const isResuming = withSegment.status === "paused";
	const isTesting = !isResuming && hasAbTest(withSegment);
	const campaign = isTesting ? await startAbTest(withSegment) : withSegment;
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getSendProblem({ campaign, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);

	const newEmails = isResuming
		? await countQueuedEmails(campaign)
		: await countNewEmails({ campaign, newsletter, audienceLimit: campaign.audienceLimit });
	const reached = isResuming ? (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0) : 0;
	await assertCanSendCampaign(account, newEmails, { campaignId: campaign._id, total: isResuming ? Math.max(reached, newEmails) : newEmails });

	if (!isResuming) await insertCampaignMessages(campaign, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign);
	if (recipients + lastChances === 0) throw fail("no_recipients", "No active contacts to send to");

	// A resume keeps its send's pace, so pausing can't speed a send up.
	const spreadMs = isResuming ? (campaign.spreadHours ?? 0) * HOUR_MS : await getPaceMs(account, recipients + lastChances);
	// The wait starts once the slice has gone out: a paced slice takes its hours first.
	const pickAt = isTesting ? new Date(Date.now() + spreadMs + campaign.abTest.waitMinutes * MINUTE_MS) : null;
	const { modifiedCount } = await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id, status: campaign.status },
		{
			$set: {
				status: "sending",
				...feedHtml,
				"stats.recipients": recipients,
				"lastChance.recipients": lastChances,
				...(spreadMs && { spreadHours: spreadMs / HOUR_MS }),
				...(segment && { segmentSnapshot: segment }),
				...(isTesting && { audienceLimit: campaign.audienceLimit, abTest: { ...campaign.abTest, pickAt } }),
				...(isResuming && RATE_PAUSE_CODES.has(campaign.pauseCode) && { ratesAcceptedAt: new Date() }),
			},
			$unset: { pauseReason: 1, pauseCode: 1 },
			$min: { startedAt: new Date() },
		}
	);
	if (!modifiedCount) throw fail("conflict", "The campaign changed, refresh and try again");

	try {
		// A resend's emails link to the page of the campaign it copies.
		if (!isResend(campaign)) await assignArchiveSlug({ campaign, newsletter });
		if (!isResuming) await recordCampaignLinks(campaign, newsletter);
		await startWarmup(account);
		const batches = await publishSend(campaign, spreadMs, { isResuming });
		if (batches === 0) await settleCampaign(campaign.accountId, campaign._id);
		if (isTesting) await publishAbTestPick(campaign, pickAt);
		// A pick that found the test paused waits for its resume.
		else if (campaign.abTest?.status === "testing") await publishAbTestPick(campaign, new Date(Math.max(Date.now(), new Date(campaign.abTest.pickAt ?? 0).getTime())));
		return { recipients, batches };
	} catch (error) {
		await pauseCampaign({
			accountId: campaign.accountId,
			campaignId: campaign._id,
			reason: `queueing failed: ${formatError(error)}`,
		});
		throw fail("unavailable", `Could not queue the campaign, it is paused: ${formatError(error)}`);
	}
}

// Sending in steps: a sent campaign goes to the next most engaged contacts. It takes the top of the
// audience again and the one-email-per-contact index skips everyone who already received it.
export async function sendToMoreContacts({ accountId, campaignId, additional }) {
	const { account, campaign, newsletter } = await loadCampaignSend({ accountId, campaignId });
	if (campaign.status !== "sent") throw fail("conflict", "Wait until the current step has gone out");
	if (campaign.abTest?.status === "testing") throw fail("conflict", "The subject line test sends its winner to the rest once it's picked");
	if (campaign.publishTo === "web") throw fail("conflict", "This issue was published on the web only");
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getSendProblem({ campaign, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);

	const [sentSoFar, lastChancesSoFar] = await countCampaignMessages(campaign);
	const audienceLimit = getNextStepLimit({ sentSoFar, additional });
	// At least this many: contacts who got it and left since make room for new ones.
	const newEmails = await countNewEmails({ campaign, newsletter, audienceLimit, issuesSoFar: sentSoFar });
	await assertCanSendCampaign(account, newEmails, { campaignId: campaign._id, total: sentSoFar + lastChancesSoFar + newEmails });

	await insertCampaignMessages({ ...campaign, audienceLimit }, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign);
	if (recipients === sentSoFar && lastChances === lastChancesSoFar) throw fail("no_recipients", "Everyone has received it already");

	const spreadMs = await getPaceMs(account, recipients - sentSoFar + lastChances - lastChancesSoFar);
	const { modifiedCount } = await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id, status: "sent" },
		{
			$set: {
				status: "sending",
				"stats.recipients": recipients,
				"lastChance.recipients": lastChances,
				...(audienceLimit && { audienceLimit }),
				...(spreadMs && { spreadHours: spreadMs / HOUR_MS }),
				// A test's winner going to the rest, whether its pick or its owner sends it.
				...(campaign.abTest?.status === "picked" && !campaign.abTest.restSentAt && { "abTest.restSentAt": new Date() }),
			},
			$unset: { pauseReason: 1, pauseCode: 1, "abTest.problem": 1, ...(!audienceLimit && { audienceLimit: 1 }), ...(!spreadMs && { spreadHours: 1 }) },
		}
	);
	if (!modifiedCount) throw fail("conflict", "The campaign changed, refresh and try again");

	try {
		const batches = await publishSend(campaign, spreadMs);
		if (batches === 0) await settleCampaign(campaign.accountId, campaign._id);
		return { added: recipients - sentSoFar, recipients, batches };
	} catch (error) {
		await pauseCampaign({
			accountId: campaign.accountId,
			campaignId: campaign._id,
			reason: `queueing failed: ${formatError(error)}`,
		});
		throw fail("unavailable", `Could not queue the next step, the campaign is paused: ${formatError(error)}`);
	}
}

// Every issue counts toward the list cleanup until a sign of life sets the count back (lib/cleanup.js).
async function recordSent({ message, campaign, contact, providerMessageId, sentAt }) {
	const { accountId } = message;
	const statsPath = getCampaignStatsPath(message.kind);
	const variantPath = message.kind === "campaign" && Number.isInteger(message.variant) ? `abTest.variants.${message.variant}` : null;
	// Three rows, written at once: each update is a read and a write on its own, and one after another they were the longest
	// wait of every message of a send.
	await Promise.all([
		Message.updateOne(
			{ accountId, _id: message._id },
			{ $set: { ...(providerMessageId && { providerMessageId }), sentAt }, $unset: { error: 1 } }
		),
		campaign && Campaign.updateOne({ accountId, _id: campaign._id }, { $inc: { [`${statsPath}.sent`]: 1, ...(variantPath && { [`${variantPath}.sent`]: 1 }) } }),
		Contact.updateOne(
			{ accountId, _id: contact._id },
			{
				$set: { lastSentAt: sentAt, ...(message.kind === "last-chance" && { lastChanceAt: sentAt }) },
				$inc: { "stats.sent": 1, ...(message.kind === "campaign" && { ignoredIssues: 1 }) },
			}
		),
	]);
}

// The provider refuses the address for this account: it's kept out of the account's next sends too.
async function recordSuppressed({ message, error }) {
	const { accountId } = message;
	await Message.updateOne({ accountId, _id: message._id }, { $set: { status: "suppressed", error: formatError(error) } });
	await Suppression.updateOne(
		{ accountId, email: message.email },
		{ $setOnInsert: { reason: "provider", detail: formatError(error).slice(0, 200) } },
		{ upsert: true }
	);
}

async function recordFailed({ message, campaign, error }) {
	const { accountId } = message;
	await Message.updateOne(
		{ accountId, _id: message._id },
		{ $set: { status: "failed", error: formatError(error) } }
	);
	if (campaign) {
		await Campaign.updateOne(
			{ accountId, _id: campaign._id },
			{ $inc: { [`${getCampaignStatsPath(message.kind)}.failed`]: 1 } }
		);
	}
}

// Skipped for good: a month reset or an upgrade lets the next ones go, not this one. The owner hears once a month.
async function skipWelcomeEmail(account, message) {
	await Message.updateOne(
		{ accountId: account._id, _id: message._id, status: "queued" },
		{ $set: { status: "skipped", error: WELCOME_PAUSED_REASON } }
	);
	if (!(await claimWelcomePausedNotice(account._id))) return;
	const notice = getWelcomePauseNotice({
		emailsLimit: getAccountLimits(account).emails,
		extraEmailsLimit: getExtraEmailsLimit(account),
		periodEnd: account.usage?.periodEnd,
	});
	// The account's usage.welcomePausedAt already holds it to once a month, however close two months' ends are.
	await sendAlert({
		accountId: account._id,
		key: "welcome-paused",
		title: notice.title,
		detail: `${notice.detail} Confirmation emails still go out.`,
		path: "/billing",
		cooldownMinutes: 0,
	});
}

// At most once per message: the queued -> sent claim happens before SES is called. Campaign and welcome emails
// take room in the plan first (claimPlanEmails); what a batch doesn't send goes back at the end.
export async function sendMessageBatch({ accountId, messageIds }) {
	assertSendingEnabled();
	const ids = [
		...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id).toLowerCase())),
	]
		.filter(isObjectIdString)
		.slice(0, MAX_BATCH_MESSAGES);
	const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0, retry: false };
	if (ids.length === 0 || !isObjectIdString(String(accountId))) return result;

	await connectDb();
	const stored = await Account.findById(accountId).lean();
	if (!stored) {
		result.skipped = ids.length;
		return result;
	}
	const account = await rollUsagePeriod(stored);
	const order = new Map(ids.map((id, index) => [id, index]));
	const messages = (
		await Message.find({
			accountId: account._id,
			_id: { $in: ids },
			status: "queued",
			kind: { $in: [...CAMPAIGN_MESSAGE_KINDS, ...SIGNUP_KINDS, "automation"] },
		}).lean()
	).sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
	result.skipped = ids.length - messages.length;
	if (messages.length === 0) return result;

	const [campaigns, automations, newsletters, contacts, suppressedEmails, undeliverable] = await Promise.all([
		findByIds(Campaign, account._id, messages.map(({ campaignId }) => campaignId)),
		findByIds(Automation, account._id, messages.map(({ automationId }) => automationId)),
		findByIds(Newsletter, account._id, messages.map(({ newsletterId }) => newsletterId)),
		findByIds(Contact, account._id, messages.map(({ contactId }) => contactId)),
		Suppression.distinct("email", { accountId: account._id, email: { $in: messages.map(({ email }) => email) } }),
		// Checked as each batch goes, so an address listed after its send was queued is skipped too.
		findGloballySuppressed(messages.map(({ email }) => email)),
	]);
	const suppressed = new Set(suppressedEmails);
	let hasBlocked = false;
	for (const campaignId of campaigns.keys()) hasBlocked = (await stopIfUnhealthy(account._id, campaignId, account)) === "block" || hasBlocked;

	const accountProblem = getAccountSendProblem(hasBlocked ? await findAccount(account._id) : account);
	const planMessageCount = messages.filter(({ kind }) => PLAN_KINDS.has(kind)).length;
	const claim = accountProblem ? { granted: 0, extra: 0 } : await claimPlanEmails(account, planMessageCount);
	const allowance = claim.granted;
	const sentByKind = { plan: 0, confirmation: 0 };
	const senderFor = createSenderCache(account);
	const getTenant = createTenantLoader(account);

	try {
		let consecutiveFailures = 0;
		for (const message of messages) {
			if (!isSendingEnabled()) {
				result.retry = true;
				break;
			}
			const campaign = campaigns.get(String(message.campaignId)) ?? null;
			const isCampaignMessage = CAMPAIGN_MESSAGE_KINDS.includes(message.kind);
			const isAutomationMessage = message.kind === "automation";
			const automation = isAutomationMessage ? (automations.get(String(message.automationId)) ?? null) : null;
			if (isCampaignMessage) {
				const isCampaignSending = await Campaign.exists({
					accountId: account._id,
					_id: message.campaignId,
					status: "sending",
				});
				if (!isCampaignSending) {
					result.skipped++;
					continue;
				}
				// Left queued, so the send picks them up again when it resumes.
				const stopCode = accountProblem?.code ?? (sentByKind.plan >= allowance ? ERROR_CODES.planLimitEmails : null);
				if (stopCode) {
					await pauseCampaign({
						accountId: account._id,
						campaignId: message.campaignId,
						code: stopCode,
						reason: PAUSE_REASONS[stopCode],
					});
					result.skipped++;
					continue;
				}
			} else if (isAutomationMessage) {
				// Left queued: the automation tries it again once the account can send, the plan has room, or it's active again.
				if (accountProblem || sentByKind.plan >= allowance || automation?.status !== "active") {
					result.skipped++;
					continue;
				}
			} else if (accountProblem) {
				await Message.updateOne(
					{ accountId: account._id, _id: message._id, status: "queued" },
					{ $set: { status: "failed", error: accountProblem.message } }
				);
				result.failed++;
				continue;
			}

			const contact = contacts.get(String(message.contactId));
			const requiredStatus = message.kind === "confirmation" ? "pending" : "active";
			const isUndeliverable = undeliverable.has(message.email);
			if (contact?.status !== requiredStatus || suppressed.has(message.email) || isUndeliverable) {
				await Message.updateOne(
					{ accountId: account._id, _id: message._id, status: "queued" },
					{ $set: { status: "suppressed", ...(isUndeliverable && { error: UNDELIVERABLE_MESSAGE }) } }
				);
				if (isUndeliverable && contact) await markUndeliverable(account._id, contact._id);
				result.suppressed++;
				continue;
			}
			// A paid issue goes to paid readers: someone whose subscription ended since it was queued doesn't get it.
			if (message.kind === "campaign" && campaign?.audience === "paid" && !(isPaidContact(contact) && isInPaidTiers(contact, campaign.audienceTiers))) {
				await Message.updateOne(
					{ accountId: account._id, _id: message._id, status: "queued" },
					{ $set: { status: "skipped", error: NOT_PAID_REASON } }
				);
				result.skipped++;
				continue;
			}
			if (message.kind === "welcome" && sentByKind.plan >= allowance) {
				await skipWelcomeEmail(account, message);
				result.skipped++;
				continue;
			}
			// The reward is on the subscriber's referral page either way.
			if (message.kind === "referral" && sentByKind.plan >= allowance) {
				await Message.updateOne({ accountId: account._id, _id: message._id, status: "queued" }, { $set: { status: "skipped", error: WELCOME_PAUSED_REASON } });
				result.skipped++;
				continue;
			}

			const claim = await Message.updateOne(
				{ accountId: account._id, _id: message._id, status: "queued" },
				{ $set: { status: "sent", provider: mailboxProvider(message.email) } }
			);
			if (!claim.modifiedCount) {
				result.skipped++;
				continue;
			}

			const newsletter = newsletters.get(String(message.newsletterId));
			const content = getMessageContent({ kind: message.kind, newsletter, campaign, automation, stepId: message.stepId, message, contact });
			let delivery;
			try {
				if (!newsletter || !content) throw new Error("Newsletter or email content not found");
				delivery = await deliver({ message, content, newsletter, contact, sender: await senderFor(newsletter), getTenant, sentWith: showsSentWithLink(account) });
			} catch (error) {
				// Signup emails have no campaign to pause: they fail, unless the provider says to retry or skip them.
				const outcomeAction = campaign || isAutomationMessage || error?.outcome ? getSendErrorAction(error) : "fail";
				const action = !campaign && !isAutomationMessage && outcomeAction === "pause" ? "fail" : outcomeAction;
				if (error?.hold) await blockAccountForHold(account._id, error);
				await alertSendRefused(account._id, error);
				if (action === "suppress") {
					await recordSuppressed({ message, error });
					result.suppressed++;
					continue;
				}
				if (action === "fail") {
					await recordFailed({ message, campaign, error });
					result.failed++;
					consecutiveFailures++;
					if (!campaign || consecutiveFailures < MAX_CONSECUTIVE_FAILURES) continue;
					await pauseCampaign({
						accountId: account._id,
						campaignId: campaign._id,
						reason: `${consecutiveFailures} sends failed in a row`,
					});
					break;
				}
				await Message.updateOne(
					{ accountId: account._id, _id: message._id, status: "sent" },
					{ $set: { status: "queued" } }
				);
				if (action === "pause" && !isAutomationMessage) {
					await pauseCampaign({ accountId: account._id, campaignId: campaign._id, reason: formatError(error) });
				} else {
					result.retry = true;
					if (error?.retryAfter) result.retryAfter = error.retryAfter;
				}
				break;
			}

			await recordSent({ message, campaign, contact, ...delivery });
			result.sent++;
			sentByKind[PLAN_KINDS.has(message.kind) ? "plan" : "confirmation"]++;
			consecutiveFailures = 0;
		}
	} finally {
		await addEmailsSent(account._id, sentByKind.confirmation + sentByKind.plan - allowance);
		await recordExtraEmails(account, countExtraSent(claim, sentByKind.plan), { isLimitReached: !accountProblem && allowance < planMessageCount });
	}

	for (const campaignId of campaigns.keys()) await settleCampaign(account._id, campaignId);
	return result;
}

async function sendTest({ account, content, newsletter, campaignId, to }) {
	const email = normalizeEmail(to);
	if (!email) throw fail("validation_failed", "The test email address is invalid");
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getSendProblem({ campaign: content, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);

	const message = await Message.create({
		kind: "test",
		accountId: account._id,
		campaignId,
		newsletterId: newsletter._id,
		email,
		provider: mailboxProvider(email),
	});
	let delivery;
	try {
		delivery = await deliver({
			message,
			content: { ...content, subject: `[Test] ${content.subject}` },
			newsletter,
			contact: { _id: TEST_CONTACT_ID, email },
			sender,
			getTenant: createTenantLoader(account),
			sentWith: showsSentWithLink(account),
		});
	} catch (error) {
		if (error?.hold) await blockAccountForHold(account._id, error);
		await alertSendRefused(account._id, error);
		await recordFailed({ message, campaign: null, error });
		throw fail(error.name === "SenderNotAllowed" ? "sender_not_allowed" : "unavailable", formatError(error));
	}

	const { providerMessageId, sentAt } = delivery;
	await Message.updateOne(
		{ accountId: account._id, _id: message._id },
		{ $set: { status: "sent", ...(providerMessageId && { providerMessageId }), sentAt } }
	);
	await addEmailsSent(account._id, 1);
	return { messageId: String(message._id), providerMessageId, sentAt };
}

async function loadTestAccount(accountId) {
	const account = await findAccount(accountId);
	const problem = getAccountSendProblem(account);
	if (problem) throw codedError(problem);
	return account;
}

// to: one address or several. Addresses that bounced, complained or are on the never-email list are skipped, like
// they would be from a send. { sent: [{ email, messageId }], skipped: [{ email, reason }] }
export async function sendTestEmail({ accountId, campaignId, to }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");

	await connectDb();
	const account = await loadTestAccount(accountId);
	const campaign = await Campaign.findOne({ accountId: account._id, _id: campaignId }).lean();
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await Newsletter.findOne({ accountId: account._id, _id: campaign.newsletterId }).lean();
	const content = await readFeedBlocks({ account, campaign });
	const emails = [...new Set((Array.isArray(to) ? to : [to]).map((email) => normalizeEmail(email)).filter(Boolean))];
	if (emails.length === 0) throw fail("validation_failed", "The test email address is invalid");
	const [suppressed, undeliverable] = await Promise.all([
		Suppression.distinct("email", { accountId: account._id, email: { $in: emails }, reason: { $in: UNREACHABLE_REASONS } }),
		findGloballySuppressed(emails),
	]);
	const result = { sent: [], skipped: [] };
	for (const email of emails) {
		if (suppressed.includes(email) || undeliverable.has(email)) {
			result.skipped.push({ email, reason: UNDELIVERABLE_MESSAGE });
			continue;
		}
		const { messageId, sentAt } = await sendTest({ account, content, newsletter, campaignId: campaign._id, to: email });
		result.sent.push({ email, messageId });
		await Campaign.updateOne({ accountId: account._id, _id: campaign._id }, { $set: { testSentAt: sentAt } });
	}
	return result;
}

// Sends the saved welcome email, whether or not it's switched on yet.
export async function sendWelcomeTestEmail({ accountId, newsletterId, to }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(newsletterId))) throw fail("not_found", "Newsletter not found");

	await connectDb();
	const account = await loadTestAccount(accountId);
	const newsletter = await Newsletter.findOne({ accountId: account._id, _id: newsletterId }).lean();
	if (!newsletter) throw fail("not_found", "Newsletter not found");
	const content = getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
	if (!content) throw fail("send_check_failed", "Save a subject and content first");
	return sendTest({ account, content, newsletter, to });
}

const UNREACHABLE_REASONS = ["bounce", "complaint", "provider"];

// An email about something one person did, like the download link of an order: from the newsletter's own address through
// the account's tenant, with no unsubscribe link and no tracking, and one email per call (a campaign's rules about plan
// room, pacing and the list cleanup are for campaigns). It still obeys what protects the sender: a blocked account sends
// nothing, an address that bounced or complained, or is on the never-email list, gets nothing, and the from address
// and email checks apply. { sent: true } or { sent: false, reason }; a provider that is full or down throws, so the caller
// can try again. kind: "order", or "comment" for a reader's sign-in link, a reply or a moderation notice.
export async function sendTransactionalEmail({ accountId, newsletterId, to, subject, markdown, reason, kind = "order" }) {
	if (!isSendingEnabled()) return { sent: false, reason: "Sending is off" };
	const email = normalizeEmail(to);
	if (!email) return { sent: false, reason: "The email address is invalid" };

	await connectDb();
	const account = await findAccount(accountId);
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) return { sent: false, reason: accountProblem.message };
	const newsletter = await Newsletter.findOne({ accountId: account._id, _id: newsletterId }).lean();
	if (!newsletter) return { sent: false, reason: "Newsletter not found" };
	const [suppression, undeliverable] = await Promise.all([
		Suppression.findOne({ accountId: account._id, email, reason: { $in: UNREACHABLE_REASONS } }).select({ reason: 1 }).lean(),
		findGloballySuppressed([email]),
	]);
	if (suppression || undeliverable.size > 0) return { sent: false, reason: "suppressed" };

	const content = { format: "markdown", markdown, subject, previewText: "" };
	const sender = await loadSender(account, newsletter);
	const problem = getSendProblem({ campaign: content, newsletter, sender });
	if (problem) return { sent: false, reason: problem };

	const message = await Message.create({ kind, accountId: account._id, newsletterId: newsletter._id, email, provider: mailboxProvider(email) });
	let delivery;
	try {
		delivery = await deliver({
			message,
			content,
			newsletter,
			contact: { _id: TEST_CONTACT_ID, email },
			sender,
			getTenant: createTenantLoader(account),
			transactionalReason: reason,
		});
	} catch (error) {
		if (error?.hold) await blockAccountForHold(account._id, error);
		await alertSendRefused(account._id, error);
		await recordFailed({ message, campaign: null, error });
		if (getSendErrorAction(error) === "retry") throw error;
		return { sent: false, reason: formatError(error) };
	}
	const { providerMessageId, sentAt } = delivery;
	await Message.updateOne(
		{ accountId: account._id, _id: message._id },
		{ $set: { status: "sent", ...(providerMessageId && { providerMessageId }), sentAt } }
	);
	await addEmailsSent(account._id, 1);
	return { sent: true, messageId: String(message._id), providerMessageId };
}

// An account waiting for its deletion takes no signups, so it sends no signup emails either; a blocked one sends nothing.
async function getSignupEmailProblem(newsletter) {
	const account = await Account.findById(newsletter.accountId).select({ ...ACCESS_FIELDS, status: 1 }).lean();
	if (isBlocked(account)) return "account is blocked";
	return hasActiveSubscription(account) ? null : "account is being deleted";
}

export async function queueWelcomeEmail({ newsletter, contact }) {
	assertSendingEnabled();
	const content = getWelcomeContent(newsletter);
	if (!content) return { skipped: "welcome email is off" };
	if (contact?.status !== "active") return { skipped: "contact is not active" };

	await connectDb();
	const { accountId } = newsletter;
	const [isSuppressed, hasWelcome, recentWelcomes, signupProblem] = await Promise.all([
		Suppression.exists({ accountId, email: contact.email }),
		Message.exists({ accountId, kind: "welcome", contactId: contact._id }),
		countRecentSignupEmails(newsletter),
		getSignupEmailProblem(newsletter),
	]);
	if (signupProblem) return { skipped: signupProblem };
	if (isSuppressed) return { skipped: "suppressed" };
	if (hasWelcome) return { skipped: "already sent" };
	if (recentWelcomes >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	const problem = getSendProblem({ campaign: content, newsletter, sender: await loadSender({ _id: accountId }, newsletter) });
	if (problem) {
		console.warn(`[sending] Welcome email for ${newsletter.slug} not sent: ${problem}`);
		return { skipped: problem };
	}
	return sendSignupEmail({ kind: "welcome", newsletter, contact });
}

export async function queueConfirmationEmail({ newsletter, contact }) {
	assertSendingEnabled();
	if (contact?.status !== "pending") return { skipped: "contact is not pending" };

	await connectDb();
	const { accountId } = newsletter;
	const [isSuppressed, sentToContact, sentRecently, recentSignupEmails, signupProblem] = await Promise.all([
		Suppression.exists({ accountId, email: contact.email }),
		Message.countDocuments({ accountId, kind: "confirmation", contactId: contact._id }),
		Message.exists({
			accountId,
			kind: "confirmation",
			contactId: contact._id,
			createdAt: { $gte: new Date(Date.now() - WELCOME_WINDOW_MS) },
		}),
		countRecentSignupEmails(newsletter),
		getSignupEmailProblem(newsletter),
	]);
	if (signupProblem) return { skipped: signupProblem };
	if (isSuppressed) return { skipped: "suppressed" };
	if (sentRecently || sentToContact >= MAX_CONFIRMATIONS_PER_CONTACT) return { skipped: "already sent" };
	if (recentSignupEmails >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	return sendSignupEmail({ kind: "confirmation", newsletter, contact });
}

// The one reminder to confirm, for signups still pending a while after signing up (lib/confirmation-reminders.js): the
// confirmation email again, with a fresh link, its subject saying it's a reminder. They're queued and go out through the
// send-batch job, one batch at a time per account, like a campaign's.
export async function queueConfirmationReminders({ newsletter, contacts }) {
	assertSendingEnabled();
	await connectDb();
	const { accountId } = newsletter;
	const signupProblem = await getSignupEmailProblem(newsletter);
	if (signupProblem) return { skipped: signupProblem, queued: 0 };
	const emails = contacts.map(({ email }) => email);
	const [suppressed, undeliverable] = await Promise.all([Suppression.distinct("email", { accountId, email: { $in: emails } }), findGloballySuppressed(emails)]);
	const due = contacts.filter(({ status, email }) => status === "pending" && !suppressed.includes(email) && !undeliverable.has(email));
	if (due.length === 0) return { queued: 0 };
	const messages = await Message.insertMany(
		due.map((contact) => ({
			kind: "confirmation",
			reminder: true,
			accountId,
			newsletterId: newsletter._id,
			contactId: contact._id,
			email: contact.email,
			provider: mailboxProvider(contact.email),
		}))
	);
	const flowControl = { key: `account-${accountId}`, parallelism: 1 };
	const requests = chunk(
		messages.map(({ _id }) => String(_id)),
		SEND_BATCH_SIZE
	).map((messageIds) => ({ url: `${getAppUrl()}/api/jobs/send-batch`, body: { accountId: String(accountId), messageIds }, flowControl }));
	for (const group of chunk(requests, PUBLISH_CHUNK_SIZE)) await publishWith((client) => client.batchJSON(group));
	return { queued: messages.length };
}

// The email that announces a reward a subscriber unlocked (lib/referrals.js), through the same checks as a welcome email.
export async function queueReferralRewardEmail({ newsletter, contact, reward, count }) {
	assertSendingEnabled();
	if (contact?.status !== "active") return { skipped: "contact is not active" };

	await connectDb();
	const { accountId } = newsletter;
	const [isSuppressed, hasEmail, recentEmails, signupProblem] = await Promise.all([
		Suppression.exists({ accountId, email: contact.email }),
		Message.exists({ accountId, kind: "referral", contactId: contact._id, referralRewardId: reward.id }),
		countRecentSignupEmails(newsletter),
		getSignupEmailProblem(newsletter),
	]);
	if (signupProblem) return { skipped: signupProblem };
	if (isSuppressed) return { skipped: "suppressed" };
	if (hasEmail) return { skipped: "already sent" };
	if (recentEmails >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	const content = getRewardEmail({ newsletter, reward, count, pageUrl: getReferralPageUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter) });
	const problem = getSendProblem({ campaign: content, newsletter, sender: await loadSender({ _id: accountId }, newsletter) });
	if (problem) {
		console.warn(`[sending] Reward email for ${newsletter.slug} not sent: ${problem}`);
		return { skipped: problem };
	}
	return sendSignupEmail({ kind: "referral", newsletter, contact, referralRewardId: reward.id });
}

async function sendSignupEmail({ kind, newsletter, contact, referralRewardId }) {
	const message = await Message.create({
		kind,
		...(referralRewardId && { referralRewardId }),
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		contactId: contact._id,
		email: contact.email,
		provider: mailboxProvider(contact.email),
	});
	const job = { accountId: String(newsletter.accountId), messageIds: [String(message._id)] };
	const result = await sendMessageBatch(job);
	// Sent from the signup request itself: when the provider is full, QStash brings it back later.
	if (result.retry) {
		await publishBatchRetry(job, result.retryAfter).catch((error) => {
			console.error(`[sending] The ${kind} email for ${message._id} stays queued: ${error.message}`);
		});
	}
	return { messageId: String(message._id), ...result };
}

// A batch the provider couldn't take yet goes again once it says there's room, as one more QStash job.
export async function publishBatchRetry({ accountId, messageIds }, retryAfterSeconds) {
	const delay = Math.min(Math.max(Math.ceil(retryAfterSeconds || DEFAULT_RETRY_SECONDS), 10), MAX_RETRY_SECONDS);
	return publishJob({
		url: `${getAppUrl()}/api/jobs/send-batch`,
		body: { accountId: String(accountId), messageIds },
		notBefore: Math.floor(Date.now() / 1000) + delay,
		flowControl: { key: `account-${accountId}`, parallelism: 1 },
	});
}
