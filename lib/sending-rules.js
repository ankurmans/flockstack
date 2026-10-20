import { siteExtensions } from "@/lib/site-extensions";
import { getArchiveUrls, getLinkBaseUrl, getNewsletterHost } from "./archive-hosts.js";
import { LIMITS, getAppHost, getAppUrl } from "./config.js";
import { CONFIRM_URL_PLACEHOLDER } from "./confirmation-content.js";
import { areCommentsOn, getCommentAccess } from "./comment-rules.js";
import { fillCommentTags, hasCommentTags } from "./comment-tags.js";
import { SEND_OUTCOMES } from "./email-provider/outcomes.js";
import { KEEP_URL_PLACEHOLDER } from "./last-chance-content.js";
import { addUtmToLinks, getCampaignUtmSlug, getLinkUtm } from "./link-utm.js";
import { fillMergeTags } from "./merge-tags.js";
import { getPortalUrl } from "./portal-link.js";
import { getPostalAddress } from "./postal-address.js";
import { POLL_LINK_PATTERN } from "./editor-blocks.js";
import { describeBlockLevel, describeRate, judgeRates } from "./rate-levels.js";
import { fillRecommendationsTag } from "./recommendation-tags.js";
import { getEmailCommentUrl } from "./reader-links.js";
import { getReferralLink } from "./referral-links.js";
import { isReferralActive } from "./referral-rules.js";
import { fillReferralTags, hasReferralTags } from "./referral-tags.js";
import { MANAGE_URL_PLACEHOLDER, PREFERENCES_URL_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER, escapeHtml, hasContent, renderEmail } from "./render-email.js";
import { slugify } from "./slug.js";
import { getPollVoteUrl, getPreferencesUrl } from "./subscriber-links.js";
import { isPaidContact } from "./tiers.js";
import { addTracking } from "./tracking.js";
import { getUnsubscribeLinks } from "./unsubscribe.js";

export const MAX_BATCH_MESSAGES = 100;
export const MAX_CONSECUTIVE_FAILURES = 5;
// Test emails have no contact: their unsubscribe link is valid but matches nobody.
export const TEST_CONTACT_ID = "000000000000000000000000";
// A send's own messages: the issue, and last-chance emails for cold contacts (lib/cleanup.js).
export const CAMPAIGN_MESSAGE_KINDS = ["campaign", "last-chance"];

const RETRY_ERRORS = new Set(["TooManyRequestsException", "ThrottlingException", "Throttling"]);
// These fail every following send too, so the campaign pauses until the account is fixed.
const PAUSE_ERRORS = new Set([
	"AccountSuspendedException",
	"SendingPausedException",
	"MailFromDomainNotVerifiedException",
	"LimitExceededException",
	"NotFoundException",
	"SenderNotAllowed",
]);

export function chunk(items, size) {
	const chunks = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

// RFC 5322 needs quotes around names with punctuation; SES needs RFC 2047 for non-ASCII names.
export function formatFromAddress({ fromName, fromEmail }) {
	const name = String(fromName ?? "")
		.replace(/[\r\n"\\]/g, "")
		.trim();
	if (!name) return fromEmail;
	if (/^[\x20-\x7e]+$/.test(name)) return `"${name}" <${fromEmail}>`;
	return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${fromEmail}>`;
}

// Gmail's feedback loop (Google Postmaster Tools) reports a spam rate for each field on its own, so a value never repeats
// across fields or names a single email: the campaign, or the newsletter for its signup emails; the account, as
// mc-<accountId> like its tenant at either provider; the kind of email; and FlockStack, Gmail's sender ID.
export function getFeedbackId({ campaignId, newsletterId, accountId, kind }) {
	return [campaignId ?? newsletterId, `mc-${accountId}`, kind, "flockstack"]
		.map((part) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, ""))
		.join(":");
}

// Newsletters that confirm signups say it all in the confirmation email: one email, not two.
export function getWelcomeContent(newsletter) {
	if (newsletter?.requireConfirmation) return null;
	const { enabled, subject, previewText, markdown } = newsletter?.welcome ?? {};
	if (!enabled || !subject?.trim() || !markdown?.trim()) return null;
	return { format: "markdown", subject: subject.trim(), markdown, previewText: previewText?.trim() ?? "" };
}

// Issues link to their archive page. A draft has no slug yet, so its test email links to the one
// the subject gives when it goes out. Welcome emails aren't issues and have no page.
// A paid-only issue has none: its page shows a teaser, and the full text is only in the email.
export function getIssueWebUrl({ campaign, newsletter }) {
	if (!newsletter?.archiveEnabled || !newsletter.slug || !campaign?._id || campaign.archiveListed === false) return null;
	if (campaign.audience === "paid") return null;
	const slug = campaign.archiveSlug || campaign.resend?.slug || slugify(campaign.subject, 80);
	return slug ? getArchiveUrls(newsletter).absolutePost(slug) : null;
}

// What an issue's email says about its comments for one reader: the footer's "Discuss this issue" link (empty when they
// can't comment, or the newsletter has comments off) and what {{comment_link}} becomes. The link signs the reader in
// (lib/reader-links.js). A test email links to the page's comments without signing anyone in.
function getCommentLinks({ campaign, newsletter, contact, webUrl }) {
	if (!webUrl) return { footerUrl: "", tagUrl: getArchiveUrls(newsletter).siteIndex };
	if (!areCommentsOn(newsletter, campaign)) return { footerUrl: "", tagUrl: webUrl };
	const discussion = `${webUrl}#comments`;
	if (String(contact._id) === TEST_CONTACT_ID) return { footerUrl: discussion, tagUrl: discussion };
	if (!getCommentAccess({ newsletter, campaign, contact }).ok) return { footerUrl: "", tagUrl: discussion };
	const issueSlug = new URL(webUrl).pathname.split("/").pop();
	const url = getEmailCommentUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter, { issueSlug });
	return { footerUrl: url, tagUrl: url };
}

// With a messageId, opens and clicks are tracked; the unsubscribe, confirmation and keep links go in
// afterwards, untouched. Every link is on the newsletter's host (lib/archive-hosts.js).
// transactionalReason: an email about what the reader did, like an order's download link. It has no unsubscribe link or
// header and says why it came instead. A paid subscriber's emails link to their billing page (lib/portal-link.js).
// recommendations: the newsletter's live ones ({ name, pitch, url }) for the {{recommendations}} tag; null leaves the tag as written.
// sentWith: the "Sent with FlockStack" link under the footer, which a Free account's emails carry (lib/free-plan.js).
export function buildRecipientEmail({ campaign, newsletter, contact, messageId, sender, confirmUrl = "", keepUrl = "", transactionalReason = "", recommendations = null, sentWith = false }) {
	const baseUrl = getLinkBaseUrl(newsletter);
	const { pageUrl, headers } = getUnsubscribeLinks({ contactId: contact._id, newsletterId: newsletter._id }, baseUrl);
	const manageBillingUrl = !transactionalReason && isPaidContact(contact) && contact.stripeCustomerId ? getPortalUrl({ contactId: contact._id, newsletterId: newsletter._id }, baseUrl) : "";
	const webUrl = getIssueWebUrl({ campaign, newsletter });
	const comments = getCommentLinks({ campaign, newsletter, contact, webUrl });
	const isTest = String(contact._id) === TEST_CONTACT_ID;
	const rendered = renderEmail({
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		subject: campaign.subject,
		previewText: campaign.previewText,
		newsletter: { ...newsletter, postalAddress: getPostalAddress(newsletter, siteExtensions.defaultPostalAddress) },
		webUrl,
		transactionalReason,
		manageBillingUrl: manageBillingUrl && MANAGE_URL_PLACEHOLDER,
		commentsUrl: transactionalReason ? "" : comments.footerUrl,
		preferencesUrl: !transactionalReason && newsletter.preferencesLink ? PREFERENCES_URL_PLACEHOLDER : "",
		// A test email shows the paid part too, below a line saying where it starts.
		readerTier: isTest ? null : isPaidContact(contact) ? "paid" : "free",
		upgradeUrl: getArchiveUrls(newsletter).absoluteSubscribe,
		sentWith: sentWith && !transactionalReason,
		assetBase: getAppUrl(),
		listen: webUrl && campaign.listen?.minutes ? { url: `${webUrl}#listen`, minutes: campaign.listen.minutes } : null,
	});
	// Before the links are tracked, so the referral link is counted as a click. A newsletter without the program links to its
	// website instead, so a tag left in an old issue never shows up as it is.
	const hasTags = hasReferralTags(rendered.html) || hasReferralTags(rendered.text);
	const referral = hasTags && {
		link: isReferralActive(newsletter) ? getReferralLink(newsletter, contact._id) : getArchiveUrls(newsletter).siteIndex,
		count: contact.referral?.count ?? 0,
	};
	const withReferral = referral ? { html: fillReferralTags(rendered.html, referral), text: fillReferralTags(rendered.text, referral) } : rendered;
	const withComments = hasCommentTags(withReferral.html) || hasCommentTags(withReferral.text)
		? { html: fillCommentTags(withReferral.html, { link: comments.tagUrl }), text: fillCommentTags(withReferral.text, { link: comments.tagUrl }) }
		: withReferral;
	// Links to the signup pages, nothing ticked. Before the links are tracked, so a click on one is counted.
	const body = {
		html: fillRecommendationsTag(withComments.html, recommendations, "inline"),
		text: fillRecommendationsTag(withComments.text, recommendations, "text"),
	};
	// Merge tags go in before the links are tracked, so a tag inside a link's address is filled in too.
	const personalHtml = fillMergeTags(body.html, contact, { escape: escapeHtml });
	// Tagged before the links are tracked, so the redirect lands on the tagged address. Not on the emails about what a reader did.
	const tagged = newsletter.utmLinks && !transactionalReason
		? addUtmToLinks(personalHtml, getLinkUtm({ newsletterName: newsletter.name, campaignSlug: getCampaignUtmSlug(campaign) }), [getNewsletterHost(newsletter), getAppHost()])
		: personalHtml;
	const tracked = messageId ? addTracking(tagged, { baseUrl, messageId }) : tagged;
	// Each vote link signs this reader in for the vote; a test email's vote like a web reader, anonymously.
	const reference = isTest ? null : { contactId: contact._id, newsletterId: newsletter._id };
	// A reader's own link; a test email's opens the page for nobody.
	const preferencesUrl = transactionalReason ? "" : getPreferencesUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter);
	const pollUrl = (pollId, option) => getPollVoteUrl(reference, newsletter, { pollId, option: Number(option) });
	const fillLinks = (body, escape = (value) => value) =>
		body
			.replaceAll(UNSUBSCRIBE_PLACEHOLDER, pageUrl)
			.replaceAll(CONFIRM_URL_PLACEHOLDER, confirmUrl)
			.replaceAll(KEEP_URL_PLACEHOLDER, keepUrl)
			.replaceAll(MANAGE_URL_PLACEHOLDER, manageBillingUrl)
			.replaceAll(PREFERENCES_URL_PLACEHOLDER, preferencesUrl)
			.replace(POLL_LINK_PATTERN, (_, pollId, option) => escape(pollUrl(pollId, option)));
	const html = fillLinks(tracked, escapeHtml);
	return {
		// An issue may go out under a name of its own, from the newsletter's address.
		from: formatFromAddress({ fromName: campaign.fromName || newsletter.fromName, fromEmail: newsletter.fromEmail }),
		to: contact.email,
		replyTo: campaign.replyTo || sender?.replyTo || newsletter.replyTo || undefined,
		subject: fillMergeTags(campaign.subject, contact),
		html,
		text: fillLinks(fillMergeTags(body.text, contact)),
		headers: transactionalReason ? {} : headers,
		unsubscribeUrl: transactionalReason ? null : pageUrl,
		bytes: new TextEncoder().encode(html).length,
	};
}

// sender: what lib/sender.js says about the newsletter's from address, for the account sending it.
export function getSendProblem({ campaign, newsletter, sender }) {
	if (!newsletter) return "Newsletter not found";
	if (!newsletter.fromEmail) return "Add a from email to the newsletter";
	if (sender?.problem) return sender.problem;
	if (!getPostalAddress(newsletter, siteExtensions.defaultPostalAddress)) return "Add a postal address to the newsletter";
	if (!campaign?.subject?.trim()) return "Add a subject";
	if (!hasContent(campaign.format === "markdown" ? campaign.markdown : campaign.html)) return "Add content";

	const { bytes } = buildRecipientEmail({
		campaign,
		newsletter,
		contact: { _id: TEST_CONTACT_ID, email: newsletter.fromEmail },
		messageId: TEST_CONTACT_ID,
	});
	if (bytes > LIMITS.maxEmailBytes) {
		return `The email is ${Math.ceil(bytes / 1000)} KB. Gmail clips emails over 100 KB.`;
	}
	return null;
}

// A web only issue needs the website on and something to show; none of an email's checks apply. A paid issue's web page
// is a teaser, so a paid issue has to go by email.
export function getWebPublishProblem({ campaign, newsletter }) {
	if (!newsletter) return "Newsletter not found";
	if (!newsletter.archiveEnabled) return "Turn on the newsletter's website to publish on the web only";
	if (campaign.audience === "paid") return "A paid issue goes by email: its web page only shows a teaser";
	if (!campaign?.subject?.trim()) return "Add a subject";
	if (!hasContent(campaign.format === "markdown" ? campaign.markdown : campaign.html)) return "Add content";
	return null;
}

// Sending in steps: the next step reaches the most engaged contacts up to this many in total. Without
// a number it goes to everyone left.
export function getNextStepLimit({ sentSoFar, additional }) {
	const more = Number(additional);
	return Number.isInteger(more) && more > 0 ? sentSoFar + more : undefined;
}

// A campaign counts its last-chance emails apart, so open and click rates stay the issue's own.
export function getCampaignStatsPath(kind) {
	return kind === "last-chance" ? "lastChance" : "stats";
}

function sumCampaignRates(stats, lastChance) {
	const total = (key) => (stats?.[key] ?? 0) + (lastChance?.[key] ?? 0);
	return { sent: total("sent"), bounced: total("bounced"), complained: total("complained") };
}

// A send's own rates (lib/rate-levels.js). Last-chance emails go to the least engaged addresses, so their bounces
// and complaints count too. block: the whole account stops (lib/account-blocks.js), reason is what its owner reads.
// pause: the campaign pauses with reason, and its owner can resume it.
export function getCampaignRateProblem(stats = {}, lastChance = {}, limits) {
	const judged = judgeRates(sumCampaignRates(stats, lastChance), limits);
	if (!judged) return null;
	if (judged.level === "block") return { level: "block", reason: describeRate(judged, "on a campaign") };
	const check = judged.metric === "bounce" ? "Check where these contacts came from" : "Check that these contacts asked for your emails";
	return {
		level: "pause",
		reason: `${describeRate(judged, "on this campaign")}. ${check} before you resume: at ${describeBlockLevel(judged.metric, limits)}, the account is blocked.`,
	};
}

// The account as a whole, over its last days of sends: block stops it like a campaign's would; pause only warns
// its owner, since no one campaign is at fault.
export const ACCOUNT_CHECK_DAYS = 7;

export function getAccountRateProblem(counts = {}, limits) {
	const judged = judgeRates(counts, limits);
	if (!judged) return null;
	const reason = describeRate(judged, `over the last ${ACCOUNT_CHECK_DAYS} days`);
	if (judged.level === "block") return { level: "block", reason };
	return {
		level: "pause",
		reason: `${reason}. Nothing is paused, but at ${describeBlockLevel(judged.metric, limits)} the account is blocked: check where your recent contacts came from.`,
	};
}

const OUTCOME_ACTIONS = {
	[SEND_OUTCOMES.throttled]: "retry",
	[SEND_OUTCOMES.unavailable]: "retry",
	[SEND_OUTCOMES.suppressed]: "suppress",
	[SEND_OUTCOMES.domainUnverified]: "pause",
	[SEND_OUTCOMES.tenantPaused]: "pause",
	[SEND_OUTCOMES.approvalPending]: "pause",
	[SEND_OUTCOMES.misconfigured]: "pause",
	[SEND_OUTCOMES.failed]: "fail",
};

// Provider errors carry an outcome (lib/email-provider/outcomes.js); SES errors keep their AWS names.
export function getSendErrorAction(error) {
	if (error?.outcome) return OUTCOME_ACTIONS[error.outcome] ?? "fail";
	const name = error?.name;
	const message = String(error?.message ?? "");
	if (RETRY_ERRORS.has(name) || message.startsWith("Sending is off")) return "retry";
	if (PAUSE_ERRORS.has(name)) return "pause";
	if (name === "MessageRejected" && /not verified/i.test(message)) return "pause";
	return "fail";
}
