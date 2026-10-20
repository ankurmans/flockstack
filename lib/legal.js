// What the legal pages (/terms, /privacy, /sub-processors) say about the company and its choices, and nothing else: what
// the code and the infrastructure do is read from the code (lib/config.js, lib/region.js) or written on the pages.
// Anything the owner has not decided yet starts with "TODO:", and while one is left the pages answer 404 and nothing links
// to them (isLegalPublished). `node scripts/check-legal.mjs` lists what is left and exits 1 until nothing is. An empty
// string hides the sentence that uses it.
import { SUPPORT_EMAIL } from "./config.js";
import { CUSTOM_RETENTION_YEARS } from "./custom-choices.js";

export const OPERATOR_NAME = "KMF Ventures LLC";
export const OPERATOR_DESCRIPTION = "KMF Ventures LLC, a Wyoming limited liability company";

// Where privacy requests, Data Processing Agreement requests and legal notices go.
export const PRIVACY_EMAIL = SUPPORT_EMAIL;

// Governing law and jurisdiction: the state only.
export const GOVERNING_LAW = "the State of Wyoming, United States";

// The owner's price promise: existing customers hear 90 days before a price goes up.
export const PRICE_INCREASE_NOTICE_DAYS = 90;
// Yearly plans: how long after buying a customer can ask for the unused part of the year back.
export const YEARLY_REFUND_DAYS = 30;

// Amazon SES, by FlockStack Cloud region (SES_REGION in the Worker's environment; the EU one is in wrangler.jsonc).
export const SES_REGIONS = { us: "us-east-2", eu: "eu-west-1" };

// The owner sets the date on the day of publishing.
export const EFFECTIVE_DATE = "October 20, 2026";
export const LIABILITY_CAP =
	"the lesser of (a) the fees you paid to KMF Ventures LLC for the service in the 12 months before the event that gave rise to the claim, and (b) the total fees you have paid to KMF Ventures LLC for the service since you first subscribed";

// Days of notice by email before a change to the terms or the privacy policy, and before a new sub-processor.
export const CHANGE_NOTICE_DAYS = 30;
export const TERMS_CHANGE_NOTICE = `We email account owners at least ${CHANGE_NOTICE_DAYS} days before a change to the terms of service or to the privacy policy takes effect.`;
export const SUBPROCESSOR_CHANGE_NOTICE = `When we add a sub-processor, we update this page and email account owners at least ${CHANGE_NOTICE_DAYS} days before it starts handling data.`;
export const MINIMUM_AGE = 16;

// Audio versions send the text of an issue the writer chooses to ElevenLabs, a new sub-processor. The terms promise
// CHANGE_NOTICE_DAYS days' notice, so the owner sets this to the day (YYYY-MM-DD, UTC) the notice email went out and the
// page above was updated, and only then turns AUDIO_ENABLED on. Empty until the notice has gone out: the feature stays
// off on FlockStack Cloud while it is, and tests/audio-notice.test.mjs fails if the flag is on without a date that is
// at least CHANGE_NOTICE_DAYS old.
export const ELEVENLABS_NOTICE_SENT_ON = "";

// The first day ElevenLabs may handle data: the notice's day plus the notice period. null while the notice date is empty
// or isn't a date.
export function getElevenLabsStartDate(noticeSentOn = ELEVENLABS_NOTICE_SENT_ON) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(noticeSentOn)) return null;
	const sent = new Date(`${noticeSentOn}T00:00:00Z`);
	if (Number.isNaN(sent.getTime())) return null;
	return new Date(sent.getTime() + CHANGE_NOTICE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// True once the notice period is over, counted in whole UTC days.
export function isElevenLabsNoticeOver(now = new Date(), noticeSentOn = ELEVENLABS_NOTICE_SENT_ON) {
	const start = getElevenLabsStartDate(noticeSentOn);
	return start !== null && now.toISOString().slice(0, 10) >= start;
}

function formatDay(day) {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

// What the sub-processors page and the privacy policy say about when ElevenLabs starts: nothing is promised before the
// notice has gone out, and after it the dates are the owner's.
export function getElevenLabsStatus(noticeSentOn = ELEVENLABS_NOTICE_SENT_ON) {
	const start = getElevenLabsStartDate(noticeSentOn);
	if (!start) return `Not in use yet. We email account owners at least ${CHANGE_NOTICE_DAYS} days before it starts handling data.`;
	return `We emailed account owners on ${formatDay(noticeSentOn)}. It handles data from ${formatDay(start)}.`;
}

// What the privacy policy says about audio versions (lib/audio.js): the owner's account at ElevenLabs reads the text, and the
// finished file is FlockStack's.
export const AUDIO_VERSIONS_STORED =
	"when you create an audio version of an issue, the text of that issue as a voice reads it (the title, headings, paragraphs, list items, the words of links and footnotes, with no pictures) is sent to ElevenLabs, a text-to-speech service in the United States, which makes the audio. Nothing is sent until you click Create audio version, and never a subscriber's email address or other list data. For an issue with a paywall break, only what comes before it is read, unless the whole issue is for paid subscribers. FlockStack keeps the finished MP3 in a private bucket of your region and plays it to readers through your newsletter's website; paid issues' audio only to paid readers. FlockStack counts the characters each account has read in a month, to keep to its plan";
export const AUDIO_VERSIONS_RETENTION =
	"our copy of an audio version stays until you delete it or delete the account, and a copy you replace is deleted when its replacement is ready. ElevenLabs keeps each request in its history, which it needs to keep a voice steady from one part of an issue to the next, under its own retention terms: its data processing agreement lets it delete customer content after 180 days of inactivity, without promising to. Deleting an audio version does not delete ElevenLabs' copy; write to " + PRIVACY_EMAIL + " and we ask ElevenLabs to";

// Polar's docs (polar.sh/docs/merchant-of-record/introduction) say it is the merchant of record and handles sales tax.
export const TAX_NOTE =
	"Polar is the merchant of record for FlockStack plans and handles sales tax and VAT on them. If you sell through your own Stripe account, you are responsible for the tax on what you sell.";
export const PRIVACY_REQUEST_RESPONSE = "We answer privacy requests within 30 days.";
// Cloudflare's docs: Workers logs on the Workers Paid plan, which the account is on.
export const LOG_RETENTION = "Cloudflare keeps the Workers logs for 7 days.";
// Cloudflare's docs: D1 Time Travel restore points on the Workers Paid plan.
export const BACKUP_RETENTION =
	"Cloudflare keeps restore points of the database (D1 Time Travel) for 30 days, so deleted data can still exist in a restore point for up to 30 days.";

// What each provider's own public data processing terms say about moving personal data out of the EU and the UK, read on
// 2026-10-18 from the page in `source`. Only what the page says: add a safeguard here only after reading it there.
export const TRANSFER_SAFEGUARDS = [
	{
		name: "Cloudflare",
		text: "Its data processing agreement applies the EU standard contractual clauses, with the UK addendum and Swiss changes, and says Cloudflare complies with the EU-US Data Privacy Framework.",
		source: "https://www.cloudflare.com/cloudflare-customer-dpa/",
	},
	{
		name: "Amazon Web Services",
		text: "Its data processing addendum applies the EU standard contractual clauses automatically when a customer uses AWS services to transfer personal data.",
		source: "https://aws.amazon.com/compliance/gdpr-center/",
	},
	{
		name: "Upstash",
		text: "Its data processing agreement commits it to safeguards such as standard contractual clauses or another recognized transfer mechanism, and names the Data Privacy Framework as one.",
		source: "https://upstash.com/static/trust/dpa.pdf",
	},
	{
		name: "Polar",
		text: "Its privacy policy says it has entered into the standard contractual clauses adopted by the European Commission.",
		source: "https://polar.sh/legal/privacy",
	},
	{
		name: "Stripe",
		text: "Its data processing agreement names the EU-US Data Privacy Framework, the EU standard contractual clauses and the UK addendum as its transfer mechanisms.",
		source: "https://stripe.com/en-us/legal/dpa",
	},
	{
		name: "PostHog",
		text: "Its data processing agreement applies the standard contractual clauses (EU, UK and Swiss) and says it participates in the EU-US Data Privacy Framework.",
		source: "https://posthog.com/dpa",
	},
	{
		name: "ElevenLabs",
		text: "Its data processing agreement applies the EU standard contractual clauses (controller to processor, or processor to processor), with the UK addendum and Swiss changes. It doesn't say ElevenLabs is certified under the EU-US Data Privacy Framework.",
		source: "https://elevenlabs.io/dpa",
	},
	{
		name: "Google",
		text: "Its data processing terms apply the standard contractual clauses where no other transfer solution is available, and say Google has certified under the Data Privacy Framework.",
		source: "https://business.safety.google/processorterms/",
	},
];

// The Custom plan's request form (/custom, lib/custom-requests.js). The privacy page prints "Stored: <STORED>. How long: <RETENTION>".
export const CUSTOM_REQUEST_STORED =
	"what you type into the form: your name, work email address, newsletter or company, website, current platform, how many subscribers and emails a month you send, the things you tick that you would need, your timeline and your message, with the date and the region you sent it to, and the status and notes we add. It is stored in the database of that region and read by the FlockStack team. We use it to reply to you and to decide what to build, and for nothing else. The alert emails to the team say the size and the needs of a request but not your name or address, and we email you a short confirmation. The form's rate limits count requests by IP address and by a keyed hash of your email address, for a few minutes to a day";
export const CUSTOM_REQUEST_RETENTION = `We keep a request while we are talking and for ${CUSTOM_RETENTION_YEARS} years after the last change we make to it, then it is deleted. To have yours deleted sooner, write to ${PRIVACY_EMAIL}: we delete it on request.`;

// What the support assistant keeps (lib/marketing/support-assistant.js): the conversation lives in the browser tab
// (sessionStorage), each question goes with it to Workers AI through AI Gateway with logging off, and the server counts
// questions by IP address and user ID for its limits. "Email a human" sends it to support only on the person's click.
// The privacy page prints "Stored: <STORED>. How long: <RETENTION>".
export const SUPPORT_CHAT_STORED =
	"nothing by FlockStack. The conversation stays in your browser tab. Each question, with the conversation before it, is sent to Cloudflare Workers AI to write the answer, with logging turned off for it, and our servers only count questions by IP address and user ID, with no text, to limit how many are asked. If you click Email a human, the conversation and your account email are emailed to our support inbox";
export const SUPPORT_CHAT_RETENTION =
	"FlockStack keeps nothing of the conversation: it is gone when you close the tab or sign out, and the counters expire within two days and are then cleaned up. A conversation you email to us stays in the support inbox as long as we need it to answer you, and you can ask us to delete it.";
// The writing tools in the editor (lib/ai.js, lib/actions/ai.js): the text a writer selects, or the draft of the issue they ask
// about, goes to Workers AI through AI Gateway with logging off; nothing about a reader does. The server keeps a count per
// account per day (models/AiUsage.js) for the plan's limit. The privacy page prints "Stored: <STORED>. How long: <RETENTION>".
export const AI_WRITING_STORED =
	"nothing of the text. When you use an AI writing tool, the text you selected or the draft of the issue you asked about is sent to Cloudflare Workers AI, with logging turned off for it, and the answer comes back to your screen. No subscriber's data is sent. We store only how many requests your account made each day, to apply your plan's daily limit";
export const AI_WRITING_RETENTION = "The daily counts are deleted after about two weeks. The text and the answers are not kept by FlockStack.";
// Cloudflare's Workers AI data usage page (developers.cloudflare.com/workers-ai/platform/data-usage/), read on
// 2026-10-18. Only what the page says.
export const SUPPORT_AI_PROVIDER_NOTE =
	"Cloudflare's Workers AI documentation says that Cloudflare does not use Customer Content processed by Workers AI to train AI models, and does not retain inputs or outputs after they are no longer needed to process the request.";
// PostHog's own retention (posthog.com/docs/data/events-retention): 1 year on its free plan, 7 years on paid plans, not shortenable.
export const ANALYTICS_RETENTION =
	"PostHog keeps analytics events for up to 7 years (1 year on its free plan) and then deletes them. On request, we delete the analytics data tied to your account in PostHog.";

// The publish gate: set it, to anything that does not start with "TODO:", once Google sign-in, PostHog with the EU consent
// banner and the support assistant are live as the pages describe them. The pages stay hidden until then, so those can be
// deployed first.
export const SERVICES_LIVE_CONFIRMED = "Confirmed 2026-10-19: Google sign-in, PostHog with the EU consent banner and the support assistant are live";

// Which of the optional services in lib/subprocessors.js FlockStack Cloud uses.
export const OPTIONAL_SERVICES_IN_USE =
	"Of these, FlockStack Cloud uses Google sign-in and Sign in with Apple. It does not use Google Postmaster Tools, Telegram alerts, Upstash Redis, Unsplash or the DNS helper.";
// Where PostHog's analytics runs, and for whom. One PostHog project on PostHog US Cloud serves both deployments
// (components/marketing/SiteAnalytics.jsx, lib/marketing/analytics-consent.js, and ANALYTICS_PATHS in data/site.js of the
// marketing website, which serves the home, pricing, comparison and blog pages): change them together.
export const ANALYTICS_RULE =
	"One PostHog project, on PostHog US Cloud, serves both flockstack.io and eu.flockstack.io. It runs on FlockStack's own pages only (the home page, the pricing, comparison and blog pages, the docs, the legal pages, sign-in and the dashboard), never on a newsletter's public pages or on the pages readers use (the archive, unsubscribe, confirm, keep, referral and comment pages, and the recommendations directory). It uses its own cookies or local storage, so it runs only after you accept if you are in the EU, the EEA, the UK or Switzerland, or on eu.flockstack.io. Elsewhere it runs unless you decline in Cookie settings. A Global Privacy Control or Do Not Track signal from your browser turns it off, without a banner. Session recording is off.";

// What a newsletter's website counts about its visitors, for its owner's reports (lib/web-analytics.js, components/TrackVisit.jsx):
// change them together. This is the newsletters' own pages; FlockStack's analytics above is only FlockStack's.
export const WEB_ANALYTICS_RULE =
	"A newsletter's website counts page views, the websites that sent visitors, countries and the issues read, for its owner's reports. It sets no cookie, uses no browser storage for this and loads no script from another company. A visitor is only a hash of their network address and browser, made with a key that changes every day and is never stored: it decides which of a few hundred counters for that day goes up, so the owner sees an estimate of distinct visitors for each day, nobody can tell who they were, and the same person on another day is a new visitor. The country is the one Cloudflare reports for the visitor's network. A browser that sends Do Not Track or Global Privacy Control is not counted. What is kept is one row of counts for each newsletter and day.";

const VALUES = {
	EFFECTIVE_DATE,
	LIABILITY_CAP,
	TERMS_CHANGE_NOTICE,
	MINIMUM_AGE,
	TAX_NOTE,
	PRIVACY_REQUEST_RESPONSE,
	LOG_RETENTION,
	BACKUP_RETENTION,
	SUBPROCESSOR_CHANGE_NOTICE,
	OPTIONAL_SERVICES_IN_USE,
	ANALYTICS_RULE,
	WEB_ANALYTICS_RULE,
	SUPPORT_CHAT_STORED,
	SUPPORT_CHAT_RETENTION,
	AI_WRITING_STORED,
	AI_WRITING_RETENTION,
	CUSTOM_REQUEST_STORED,
	CUSTOM_REQUEST_RETENTION,
	SUPPORT_AI_PROVIDER_NOTE,
	ANALYTICS_RETENTION,
	AUDIO_VERSIONS_STORED,
	AUDIO_VERSIONS_RETENTION,
	SERVICES_LIVE_CONFIRMED,
	OPERATOR_NAME,
	OPERATOR_DESCRIPTION,
	PRIVACY_EMAIL,
	GOVERNING_LAW,
};

// The constants still holding a placeholder, as [name, text].
export function getLegalTodos(values = VALUES) {
	return Object.entries(values).filter(([, value]) => typeof value === "string" && value.startsWith("TODO:"));
}

// The public legal pages, for the sitemap, the footer, llms.txt and the links between them, through getPublishedLegalPages.
export const LEGAL_PAGES = [
	{
		href: "/terms",
		title: "Terms of service",
		label: "Terms",
		summary: "The rules for using FlockStack Cloud: plans, acceptable use, blocks, your data, refunds and liability.",
		description: "The terms of service for FlockStack Cloud: accounts, plans and refunds, what is allowed, what happens when an account is paused, and who owns your data.",
	},
	{
		href: "/privacy",
		title: "Privacy policy",
		label: "Privacy",
		summary: "What FlockStack collects, how long it keeps it, where it is stored and how to use your rights.",
		description: "The privacy policy for FlockStack Cloud: what we collect from account holders and for their subscribers, retention, regions, your rights and cookies.",
	},
	{
		href: "/sub-processors",
		title: "Sub-processors",
		label: "Sub-processors",
		summary: "Every service that can touch personal data, with its purpose, data and location in each region.",
		description: "The services FlockStack Cloud uses to run, with what each does, the data it can touch and where it runs in the US and EU regions, plus how to ask for a DPA.",
	},
];

export const LEGAL_PATHS = LEGAL_PAGES.map(({ href }) => href);

// LEGAL_PREVIEW is for tests and local review only: production must never show a page that still prints a TODO.
export function isLegalPublished() {
	return getLegalTodos().length === 0 || process.env.LEGAL_PREVIEW === "true";
}

// The legal pages to link to and list: none until they are published.
export function getPublishedLegalPages() {
	return isLegalPublished() ? LEGAL_PAGES : [];
}
