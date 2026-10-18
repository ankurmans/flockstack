// What the legal pages (/terms, /privacy, /sub-processors) say about the company and its choices, and nothing else: what
// the code and the infrastructure do is read from the code (lib/config.js, lib/region.js) or written on the pages.
// Anything the owner has not decided yet starts with "TODO:", and while one is left the pages answer 404 and nothing links
// to them (isLegalPublished). `node scripts/check-legal.mjs` lists what is left and exits 1 until nothing is. An empty
// string hides the sentence that uses it.
import { SUPPORT_EMAIL } from "./config.js";

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
export const EFFECTIVE_DATE = "TODO: the date these pages take effect";
export const LIABILITY_CAP =
	"the lesser of (a) the fees you paid to KMF Ventures LLC for the service in the 12 months before the event that gave rise to the claim, and (b) the total fees you have paid to KMF Ventures LLC for the service since you first subscribed";

// Days of notice by email before a change to the terms or the privacy policy, and before a new sub-processor.
export const CHANGE_NOTICE_DAYS = 30;
export const TERMS_CHANGE_NOTICE = `We email account owners at least ${CHANGE_NOTICE_DAYS} days before a change to the terms of service or to the privacy policy takes effect.`;
export const SUBPROCESSOR_CHANGE_NOTICE = `When we add a sub-processor, we update this page and email account owners at least ${CHANGE_NOTICE_DAYS} days before it starts handling data.`;
export const MINIMUM_AGE = 16;
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
		name: "Google",
		text: "Its data processing terms apply the standard contractual clauses where no other transfer solution is available, and say Google has certified under the Data Privacy Framework.",
		source: "https://business.safety.google/processorterms/",
	},
];

// What the support assistant keeps (lib/marketing/support-assistant.js): the conversation lives in the browser tab
// (sessionStorage), each question goes with it to Workers AI through AI Gateway with logging off, and the server counts
// questions by IP address and user ID for its limits. "Email a human" sends it to support only on the person's click.
// The privacy page prints "Stored: <STORED>. How long: <RETENTION>".
export const SUPPORT_CHAT_STORED =
	"nothing by FlockStack. The conversation stays in your browser tab. Each question, with the conversation before it, is sent to Cloudflare Workers AI to write the answer, with logging turned off for it, and our servers only count questions by IP address and user ID, with no text, to limit how many are asked. If you click Email a human, the conversation and your account email are emailed to our support inbox";
export const SUPPORT_CHAT_RETENTION =
	"FlockStack keeps nothing of the conversation: it is gone when you close the tab or sign out, and the counters expire within two days and are then cleaned up. A conversation you email to us stays in the support inbox as long as we need it to answer you, and you can ask us to delete it.";
// Cloudflare's Workers AI data usage page (developers.cloudflare.com/workers-ai/platform/data-usage/), read on
// 2026-10-18. Only what the page says.
export const SUPPORT_AI_PROVIDER_NOTE =
	"Cloudflare's Workers AI documentation says that Cloudflare does not use Customer Content processed by Workers AI to train AI models, and does not retain inputs or outputs after they are no longer needed to process the request.";
export const ANALYTICS_RETENTION = "TODO: how long PostHog keeps analytics events (the retention set in the PostHog project)";

// The publish gate: set it, to anything that does not start with "TODO:", once Google sign-in, PostHog with the EU consent
// banner and the support assistant are live as the pages describe them. The pages stay hidden until then, so those can be
// deployed first.
export const SERVICES_LIVE_CONFIRMED = "TODO: set once Google sign-in, PostHog (with the EU consent banner) and the support assistant are live";

// Which of the optional services in lib/subprocessors.js FlockStack Cloud uses.
export const OPTIONAL_SERVICES_IN_USE = "Of these, FlockStack Cloud uses Google sign-in. It does not use Google Postmaster Tools, Telegram alerts, Upstash Redis or the DNS helper.";
// Where PostHog's analytics runs, and for whom. One PostHog project on PostHog US Cloud serves both deployments
// (components/marketing/SiteAnalytics.jsx, lib/marketing/analytics-consent.js): change them together.
export const ANALYTICS_RULE =
	"One PostHog project, on PostHog US Cloud, serves both flockstack.io and eu.flockstack.io. It runs on FlockStack's own pages only (the home page, the docs, the legal pages, sign-in and the dashboard), never on a newsletter's public pages or on the pages readers use (the archive, unsubscribe, confirm, keep, referral and comment pages, and the recommendations directory). It uses its own cookies or local storage, so it runs only after you accept if you are in the EU, the EEA, the UK or Switzerland, or on eu.flockstack.io. Elsewhere it runs unless you decline in Cookie settings. A Global Privacy Control or Do Not Track signal from your browser turns it off, without a banner. Session recording is off.";

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
	SUPPORT_CHAT_STORED,
	SUPPORT_CHAT_RETENTION,
	SUPPORT_AI_PROVIDER_NOTE,
	ANALYTICS_RETENTION,
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
