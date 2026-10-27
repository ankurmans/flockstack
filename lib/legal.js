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
export const BRAND_DOMAINS_STORED = "For automatic brand domain setup, the server operator assigns domains and Cloudflare zones to your account. When you request setup, their DNS records are sent to Cloudflare and domain verification is requested from Amazon SES. No subscriber data is sent for DNS setup. We also keep each newsletter's sending brake and warm-up dates in your region's database.";

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
export const ACCOUNT_ASSISTANT_STORED = "The account owner can explicitly authorize a newsletter-bound account assistant. After consent, conversation text and selected authored drafts, the private writing brief and bounded, redacted tool results go to Cloudflare Workers AI on its global network, possibly outside the region, with gateway logging and caching off. No contact records, sender details, keys, billing data, exports or private editorial notes are automatically sent to the model. FlockStack keeps no server chat transcript; the recent conversation stays in the browser tab until cleared, reloaded or closed. Internal grant IDs, levels, expiry and usage are stored and revocable like API keys, without a usable bearer token. Tools create ordinary drafts, plans, segments, activity records or approval requests with their existing retention and exports. Each started model call shares the daily AI allowance; counters are kept for about two weeks";
export const AI_IMAGES_STORED = "When you explicitly request an AI image, your description goes to Cloudflare Workers AI on its global network, possibly outside your region, with gateway logging and caching off. The generated image is saved in the ordinary public image store, where anyone with its URL may load it. FlockStack keeps its model and creation date with the upload record, not the description. The record is included in account exports and removed with the account; image deletion follows the same rules as other uploaded images. Daily attempt counts share the writing tools' allowance and are retained for about two weeks";
export const AI_WRITING_RETENTION = "The daily counts are deleted after about two weeks. The text and the answers are not kept by FlockStack.";
export const METERED_READING_STORED = "When a newsletter offers free reads of paid issues, a signed-in free reader must choose to use one before the full web issue opens. We store the subscriber ID, month, count and chosen issue IDs in the newsletter’s regional database until seven days after that UTC calendar month ends, then the hourly cleanup removes them. Reopening the same issue in that month does not spend another read. This does not grant paid subscription, email, audio or perk access; issues restricted to a specific paid tier or carrying a minimum-tier block are excluded. Disabling metered reading revokes this access. The history is included in account exports and deleted when the contact or account is deleted. No anonymous IP tracking or new cookie is used for the meter";

export const MAILING_LISTS_STORED = "A newsletter may offer optional email lists. We keep each subscriber’s chosen list IDs with their contact in the newsletter’s regional database. Readers can change those choices through a signed preference link or their account page; the creator can also record choices with consent. Choices affect only list-targeted emails, and general newsletter issues may still arrive. Leaving the newsletter stops its emails regardless of list membership. Choices are included in account exports and removed with the contact or account. Archiving a list hides new choices while preserving its existing memberships and campaign targeting";

export const SUBSCRIBER_PERKS_STORED = "A reader can choose to show a supporter badge beside their public comments. It is off by default. We store that choice and its latest update time with their subscriber record and include it in private exports. The public badge is shown only while the reader is active and has current access in a founding tier. Comment pages request current badge IDs separately, without exposing subscriber IDs, emails, tier names, amounts or consent timestamps. Badge checks are refreshed on visible pages about once a minute and on focus; failed checks hide badges. Removing the contact or account removes the preference. A paid-trial offer stores a one-time upfront access fee and its currency with its terms. Stripe Checkout bills that fee on the initial invoice; the recurring plan starts after the trial and renews until canceled. The creator receives the payment through their own Stripe account. While the subscription is trialing, FlockStack grants access only after reading a paid initial invoice for the expected currency and at least that fee. Offer settings are included in private exports and are not revenue evidence. A signup form may store an ordered optional survey, paid-offer and recommendation flow and a completion redirect. A newly created subscriber receives a one-hour signed flow link, without a new cookie or analytics. Existing addresses get a public flow without their private subscriber capability. Survey answers use the existing survey storage; paid offers open the plan picker and recommendations require the reader’s own choice. Form configuration is included in private account exports. Referral rewards can store exact private code inventory, assign-once receipts and complimentary gift links for an active subscriber. These are included in private account exports. Code assignments remain used after contact deletion, with the contact’s reward receipt deleted, so a code is never issued twice. Gift redemptions keep a private per-contact receipt to prevent duplicate access; gift records retain their existing access and payment history. Gifted months do not change Stripe charges. For automation email tests, the selected variant, allocation, copy revision and test or winner mode are kept with delivery records and included in private account exports. Each recipient receives one selected version. The owner can keep derived internal issue link references; these show only in the scoped owner dashboard and API. Audience blocks are stored with the issue and filtered for the reader’s current paid tier before email, web and translation output; the public page contains only public/free content. Guest author names, biographies and pictures are public profiles on the newsletter website. Paid subscriber perks are stored privately with the newsletter: titles, instructions, codes, destination links and optional references to product files. Only active paid readers in an allowed tier can see a perk or download its private file. The server checks the reader session and current entitlement again for each download. These settings remain until changed or the account is deleted; archiving hides a perk and refuses further downloads";
export const READER_TRANSLATIONS_STORED =
	"when a newsletter enables issue translation, a signed-in subscriber can ask to translate only the issue text they may read. That authored text goes to Cloudflare Workers AI through AI Gateway with logging and provider caching turned off; contact records, email addresses and session identifiers are not added to the request. Authored text may itself contain personal information. The translated plain text, its language, source hash and issue identifiers are cached privately in the newsletter account's database, without reader identifiers. Requests share the account's daily AI allowance";
export const READER_TRANSLATIONS_RETENTION =
	"cached translations expire after seven days and cannot then be served. A periodic job removes expired rows. They are included in account exports and deleted with the account. Daily allowance counts are deleted after about two weeks";
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
// marketing website, which serves the home, product, pricing, comparison, migration and blog pages): change them together.
//
// Session recording: SESSION_RECORDING_ON says whether the Privacy page may describe it as running. Turn it on in the same
// change as the settings: POSTHOG_SESSION_REPLAY="on" on the marketing website's Worker (recording its pages for visitors who
// pressed Accept; CRO phase 4) and, if wanted, "true" on the app's Workers (the dashboard and the pages here, every input and
// all text masked). while it is on and the retention below is still a TODO, the legal pages answer 404 like any other placeholder.
export const SESSION_RECORDING_ON = false;
export const SESSION_RECORDING_RETENTION = "TODO: PostHog's recording retention for FlockStack's project, as set in PostHog";
const SESSION_RECORDING_SENTENCE = SESSION_RECORDING_ON
	? `Session recording runs only for visitors who pressed Accept (never where analytics merely runs by default), with every input hidden, and a Global Privacy Control or Do Not Track signal stops it. Retention: ${SESSION_RECORDING_RETENTION}`
	: "Session recording is off.";
// Besides page views and clicks: which sign-up button on the website led to a sign-in page and the account created from it
// (a short fixed name such as "hero-primary", kept for that browser session only), that the cost calculator was used (never
// what was entered), and which wording of a headline or button was shown on a page that tests wording.
export const ANALYTICS_RULE =
	`One PostHog project, on PostHog US Cloud, serves both flockstack.io and eu.flockstack.io. It runs on FlockStack's own pages only (the home page, the product, pricing, comparison, migration and blog pages, the docs, the legal pages, sign-in and the dashboard), never on a newsletter's public pages or on the pages readers use (the archive, unsubscribe, confirm, keep, referral and comment pages, and the recommendations directory). It uses its own cookies, local storage or session storage, so it runs only after you accept if you are in the EU, the EEA, the UK or Switzerland, or on eu.flockstack.io. Elsewhere it runs unless you decline in Cookie settings. A Global Privacy Control or Do Not Track signal from your browser turns it off, without a banner. Besides page views and clicks it counts which sign-up button on our website you pressed and the account you then create, that you used the cost calculator (never what you entered), and which wording you were shown on a page that tests wording. ${SESSION_RECORDING_SENTENCE}`;

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
	...(SESSION_RECORDING_ON && { SESSION_RECORDING_RETENTION }),
	SUPPORT_CHAT_STORED,
	SUPPORT_CHAT_RETENTION,
	AI_WRITING_STORED,
	AI_WRITING_RETENTION,
	AI_IMAGES_STORED,
	ACCOUNT_ASSISTANT_STORED,
	SUBSCRIBER_PERKS_STORED,
	MAILING_LISTS_STORED,
	METERED_READING_STORED,
	READER_TRANSLATIONS_STORED,
	READER_TRANSLATIONS_RETENTION,
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

export const AGENT_WORKSPACES_STORED = "Provisional agent workspaces keep the private brief and draft text, hashed editing and claim capabilities and an expiry for 24 hours. A signed-in owner must claim the exact reviewed revision before any account content is created. Claiming revokes both capabilities and removes the provisional text. The full private brief stays in the claimed newsletter for the agent brief and account export until account deletion; its editorial batch holds a shortened description. Bootstrap retry records keep IDs and a brief fingerprint until account deletion.";
export const TEAM_ACCESS_STORED = "Team seats keep the invited email, role, status and, after acceptance with a verified email, user ID. They stay until account deletion. Revoking a seat stops its access. The essential flockstack.workspace cookie holds the chosen account ID for 30 days; membership is rechecked on every request. It is not an authentication credential.";
export const READER_REPLIES_STORED = "When a newsletter enables its replies inbox, replies to new campaigns reach Cloudflare Email Routing and its Email Worker, then the newsletter's region. The database keeps sender address, subject, plain text and IDs linking the reply to the subscriber and campaign for 90 days or until account deletion. Attachments and raw email are not stored by FlockStack. Reply content is not sent to an AI service. Incoming processing can run outside the storage region. No automatic response is sent.";
export const STRIPE_IMPORT_STORED = "Paid-subscriber imports read subscription and customer records from the creator's own Stripe account and keep email, customer and subscription IDs, source price, destination tier and current access period. FlockStack creates no charge or new Stripe subscription during import and keeps existing opt-outs. Signed Stripe events update access. Records stay until account deletion.";
export const SUBSCRIPTION_REVENUE_STORED = "Creator reports keep normalized Stripe subscription prices, status, tier references, financial change observations, paid invoice amounts and currencies, Stripe invoice/subscription/event IDs and observation dates in the account's region. They do not copy customer names, addresses, card details, email addresses or whole Stripe objects. These financial records remain until account deletion, including if a reader contact is removed, and are included in the private account export. A creator can explicitly refresh known subscriptions and their latest invoice; this changes no Stripe billing or reader access and sends no email. Earlier history is not automatically imported.";

export const REPLY_RULES_STORED = "Reply Rules is optional. The account owner must agree to AI processing and each reader must agree before posting or editing while it is enabled. The comment, public rules and up to three recent consenting comments manually hidden by this newsletter's owner may be processed by Cloudflare Workers AI on its global network, possibly outside the storage region, with gateway logging and caching off. Names, emails and reader or session identifiers are not added to the model request. Comments may themselves contain personal information. FlockStack does not train a model. Only manually hidden comments from the last 30 days, from still-active authors, are eligible examples; old comments without consent, comments that only consented to classification before example use was enabled, and AI-only decisions are excluded. Rules, consent timestamps and body hashes, the separate example-use choice recorded from the current notice, classification outcomes, model/rule references and unverified confidence scores are stored with the newsletter and comments and included in the owner's private export. They follow account/comment deletion; author deletion or contact anonymization removes the AI consent and decision metadata. Started model attempts share the daily AI allowance and retain counters for about two weeks. Uncertain, invalid or unavailable checks wait for review; the owner can reverse AI decisions";

export const READER_RETENTION_STORED = "When enabled by the creator, readers can schedule native Stripe pauses, accept an existing save discount once or cancel personal billing. The regional database keeps the personal subscription and customer references, provider schedule and pause dates, observed status, retry identifiers and once-only discount history. Stripe receives billing instructions, not cancellation feedback. Readers may optionally share a reason and up to 1,000 characters privately with the creator; skipping feedback does not prevent cancellation. Reader-profile deletion removes shared feedback and detaches the profile from retained billing history; account deletion removes these records. Private exports include billing observations and shared feedback, excluding internal retry payloads. Existing email billing links can manage payments after an email unsubscribe and do not subscribe the address again. Paused personal billing grants no unpaid personal access; independent funded gifts and group seats remain separate.";

export const EDITOR_COLLABORATION_STORED = "Optional realtime editing sends a draft’s body, subject, preview and cursor positions to the regional Worker’s Cloudflare Durable Object namespace. EU objects use Cloudflare’s EU jurisdiction; elsewhere Cloudflare chooses the object location. A signed ticket lasts 60 seconds and is never placed in a URL. Continued access checks the current sign-in session, account/team role and draft state. Cookies and bearer tickets are not kept in object attachments. Private CRDT snapshots can include earlier deleted draft text; they expire after 30 days without a checkpoint through hourly cleanup, with up to 100 removed per run. Idle object copies expire after a day. Private editorial threads keep author display names and IDs, selected-text quotes and relative anchors, replies, collaborator mentions and resolution/removal dates with the issue. They never enter subscriber emails or public comments, and mentions send no email. Removal clears a thread’s text, replies and mentions. Private exports include collaboration snapshots and threads; account deletion removes both database and object state before completion. Deleting a snapshot or resetting an externally changed document marks older anchors outdated without deleting the saved issue.";
