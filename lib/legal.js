// What the legal pages (/terms, /privacy, /sub-processors) say about the company and its choices, and nothing else: what
// the code and the infrastructure do is read from the code (lib/config.js, lib/region.js) or written on the pages.
// Anything the owner has not decided yet starts with "TODO:" and shows on the page as it is. `node scripts/check-legal.mjs`
// lists what is left and exits 1 until nothing is. An empty string hides the sentence that uses it.
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

export const EFFECTIVE_DATE = "TODO: the date these pages take effect";
export const LIABILITY_CAP = "TODO: the cap on KMF Ventures LLC's liability (for example, what the customer paid in the previous 12 months)";
export const TERMS_CHANGE_NOTICE = "TODO: how much notice account holders get before a change to the terms or the privacy policy takes effect (price increases are 90 days)";
export const MINIMUM_AGE = "TODO: the minimum age to use FlockStack (16 is the GDPR default)";
export const TAX_NOTE = "TODO: how sales tax or VAT on plans is handled (for example, Polar as merchant of record)";
export const PRIVACY_REQUEST_RESPONSE = "TODO: how fast privacy requests are answered (the GDPR allows one month)";
export const TRANSFER_SAFEGUARDS =
	"TODO: the safeguard for each service outside the EU or UK (standard contractual clauses, EU-US Data Privacy Framework certification), and keep only what is true";
export const LOG_RETENTION = "TODO: how long Cloudflare keeps the Workers logs (it depends on the Cloudflare plan)";
export const BACKUP_RETENTION = "TODO: whether Cloudflare keeps backups of the database (D1 Time Travel) and for how long, so deleted data can still be in them";
export const SUBPROCESSOR_CHANGE_NOTICE = "TODO: how customers hear about a new sub-processor, and how long before it starts";
export const OPTIONAL_SERVICES_IN_USE =
	"TODO: which optional services FlockStack Cloud has switched on (Google sign-in, Google Postmaster Tools, Telegram alerts, Upstash Redis, the DNS helper)";
export const SITE_EXTENSIONS_NOTE =
	"TODO: confirm that FlockStack Cloud's own marketing site, support chat and analytics (not in the open-source code) set no cookies beyond these, or list them";

const VALUES = {
	EFFECTIVE_DATE,
	LIABILITY_CAP,
	TERMS_CHANGE_NOTICE,
	MINIMUM_AGE,
	TAX_NOTE,
	PRIVACY_REQUEST_RESPONSE,
	TRANSFER_SAFEGUARDS,
	LOG_RETENTION,
	BACKUP_RETENTION,
	SUBPROCESSOR_CHANGE_NOTICE,
	OPTIONAL_SERVICES_IN_USE,
	SITE_EXTENSIONS_NOTE,
	OPERATOR_NAME,
	OPERATOR_DESCRIPTION,
	PRIVACY_EMAIL,
	GOVERNING_LAW,
};

// The constants still holding a placeholder, as [name, text].
export function getLegalTodos(values = VALUES) {
	return Object.entries(values).filter(([, value]) => typeof value === "string" && value.startsWith("TODO:"));
}

// The public legal pages, for the sitemap, the footer, llms.txt and the links between them.
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
