import { hasActiveSubscription, isBlocked, isDeletionPending } from "./account-state.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { getRegion, REGION_NAMES } from "./region.js";
import { resolveFrom } from "./sender-rules.js";

// A newsletter recommends up to this many others, each with a pitch in its own words.
export const MAX_RECOMMENDATIONS = 10;
export const MAX_PITCH_LENGTH = 160;
export const MAX_REASON_LENGTH = 200;
// What a contact's source starts with when a recommendation brought it: recommendation:<recommender's slug>.
export const SOURCE_PREFIX = "recommendation:";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const DEFAULT_DECLINE_REASON = "The newsletter's owner declined this recommendation.";

// The pitch is plain text shown on other people's pages and in their emails: no markup, no links, no merge tags.
export function normalizePitch(value) {
	const pitch = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!pitch) return { problem: "Write a pitch: a sentence on why readers would like this newsletter" };
	if (pitch.length > MAX_PITCH_LENGTH) return { problem: `The pitch is ${pitch.length} characters. ${MAX_PITCH_LENGTH} is the most.` };
	if (/[<>]|\{\{|\}\}/.test(pitch)) return { problem: "The pitch is plain text: no HTML or merge tags" };
	if (/https?:\/\/|www\./i.test(pitch)) return { problem: "The pitch is plain text without links: readers get the newsletter's own signup page" };
	return { pitch };
}

export function normalizeReason(value) {
	const reason = String(value ?? "").replace(/\s+/g, " ").trim();
	if (reason.length > MAX_REASON_LENGTH) return { problem: `The reason is ${reason.length} characters. ${MAX_REASON_LENGTH} is the most.` };
	return { reason: reason || DEFAULT_DECLINE_REASON };
}

export function normalizeSlug(value) {
	const slug = String(value ?? "").trim().toLowerCase();
	return SLUG_PATTERN.test(slug) ? slug : null;
}

// Two separate stacks, each with its own database: a slug from the other one isn't found here.
export function getRegionNote(env = process.env) {
	return `Recommendations only work between newsletters in the same region, and this is the ${REGION_NAMES[getRegion(env)]} region.`;
}

export function getNotFoundMessage(slug) {
	return `No newsletter with the slug "${slug}" in this region. ${getRegionNote()}`;
}

export const OWN_NEWSLETTER_MESSAGE = "That newsletter is in your own account. Recommendations are between newsletters of different accounts.";

// Why a newsletter can't be recommended right now, or null. newsletter: the stored one; account: its account (access fields and
// status); hasIssue: it sent its first issue, so its website is live; domains: its account's domains. The words don't say
// that an account is blocked or unpaid: that's the owner's business, and the recommender only needs to know it can't take readers.
export function getRecommendableProblem({ newsletter, account, hasIssue, domains = [] }) {
	if (!newsletter) return "This newsletter no longer exists.";
	const { name } = newsletter;
	if (newsletter.recommendations?.allowIncoming === false) return `${name} has turned off incoming recommendations.`;
	if (!account || isDeletionPending(account) || !hasActiveSubscription(account) || isBlocked(account)) {
		return `${name} can't take new subscribers right now.`;
	}
	if (!newsletter.requireConfirmation) {
		return `${name} doesn't ask new subscribers to confirm their email. Only newsletters with confirmed signups can be recommended.`;
	}
	if (!newsletter.archiveEnabled) return `${name}'s website is off, so readers have no page to sign up on.`;
	if (!hasIssue) return `${name} hasn't sent its first issue yet, so its website isn't live.`;
	// The reply-to check isn't about recommendations: any owner address passes it.
	if (resolveFrom({ newsletter, domains, ownerEmail: "owner@example.com" }).problem) {
		return `${name}'s sending address isn't verified yet, so it can't send confirmation emails.`;
	}
	return null;
}

// What a recommendation is right now. active: it shows to readers. pending: stored as active, but its newsletter can't take
// it at the moment, with the reason; it shows again when that clears. removed: taken out, with the reason and who did it.
export function getRecommendationState({ recommendation, recommended, account, hasIssue, domains }) {
	if (recommendation.status === "removed") {
		return { status: "removed", reason: recommendation.reason || "Removed.", removedBy: recommendation.removedBy ?? "system" };
	}
	if (!recommended) return { status: "removed", reason: "This newsletter no longer exists.", removedBy: "system" };
	const problem = getRecommendableProblem({ newsletter: recommended, account, hasIssue, domains });
	return problem ? { status: "pending", reason: problem, removedBy: null } : { status: "active", reason: null, removedBy: null };
}

// Where a reader lands to sign up: the recommended newsletter's website, with the recommender's slug so the signup is
// counted for it. The signup form takes it from the address (components/FormSubscribe.jsx).
export function getRecommendationLink(recommended, recommenderSlug, urls = getArchiveUrls(recommended)) {
	const url = new URL(urls.siteIndex);
	url.searchParams.set("rec", recommenderSlug);
	url.hash = "subscribe";
	return url.toString();
}

export function getRecommendationSource(recommenderSlug) {
	return `${SOURCE_PREFIX}${recommenderSlug}`;
}

export function readRecommenderSlug(source) {
	if (typeof source !== "string" || !source.startsWith(SOURCE_PREFIX)) return null;
	return normalizeSlug(source.slice(SOURCE_PREFIX.length));
}

// The directory shows ranges, never exact numbers.
const RANGES = [
	[100, "Under 100"],
	[500, "100 to 500"],
	[1000, "500 to 1,000"],
	[5000, "1,000 to 5,000"],
	[10_000, "5,000 to 10,000"],
	[50_000, "10,000 to 50,000"],
];

export function getSubscriberRange(count) {
	const found = RANGES.find(([max]) => count < max);
	return found ? found[1] : "50,000 or more";
}
