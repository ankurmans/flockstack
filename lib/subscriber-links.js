import { getLinkBaseUrl } from "./archive-hosts.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";

// Links in a newsletter's emails that act for one subscriber without a sign-in: a poll vote, a survey and the
// preference center. Like lib/reader-links.js, each kind signs with a key of its own (contact-token.js), so a vote link
// can never open someone's preferences. The poll and the option ride beside the token, unsigned: the token says who
// votes, and lib/polls.js checks the poll belongs to the token's newsletter. They live on the newsletter's host.
const DAY_MS = 86_400_000;
const KINDS = {
	// Polls are answered within days, but an old issue's poll keeps working while it's open.
	poll: { info: "flockstack-poll-vote-v1", maxAgeMs: 400 * DAY_MS },
	survey: { info: "flockstack-survey-v1", maxAgeMs: 400 * DAY_MS },
	// In every email's footer, so it lasts as long as an unsubscribe link reasonably needs to.
	preferences: { info: "flockstack-preferences-v1", maxAgeMs: 3 * 365 * DAY_MS },
};

export function createSubscriberToken(kind, { contactId, newsletterId }, now = Date.now()) {
	return createContactToken({ info: KINDS[kind].info, contactId, newsletterId }, now);
}

// { contactId, newsletterId }, or null for a token that is forged, of another kind, or too old.
export function verifySubscriberToken(kind, token, now = Date.now()) {
	return verifyContactToken(token, { info: KINDS[kind].info, maxAgeMs: KINDS[kind].maxAgeMs, now });
}

function subscriberUrl(path, newsletter, params) {
	const url = new URL(`${getLinkBaseUrl(newsletter)}${path}`);
	for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	return url.toString();
}

// reference null: a test email or a web reader, who votes without a token.
export function getPollVoteUrl(reference, newsletter, { pollId, option }) {
	return subscriberUrl("/poll", newsletter, { p: pollId, o: option, token: reference ? createSubscriberToken("poll", reference) : null });
}

export function getSurveyUrl(reference, newsletter, { surveyId, from }) {
	return subscriberUrl("/survey", newsletter, { s: surveyId, from, token: reference ? createSubscriberToken("survey", reference) : null });
}

export function getPreferencesUrl(reference, newsletter) {
	return subscriberUrl("/preferences", newsletter, { token: createSubscriberToken("preferences", reference) });
}
