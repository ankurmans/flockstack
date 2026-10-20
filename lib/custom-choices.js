// What the Custom plan's request form (/custom) offers, and what the admin tally counts. Ids are what a request stores;
// labels are what people read. No imports: the form is a client component and reads this too.

export const CUSTOM_PATH = "/custom";

export const CUSTOM_PLATFORMS = [
	{ id: "beehiiv", label: "beehiiv" },
	{ id: "substack", label: "Substack" },
	{ id: "mailchimp", label: "Mailchimp" },
	{ id: "kit", label: "Kit" },
	{ id: "ghost", label: "Ghost" },
	{ id: "wordpress", label: "WordPress" },
	{ id: "other", label: "Other" },
];

export const CUSTOM_SUBSCRIBER_RANGES = [
	{ id: "under-100k", label: "Under 100,000" },
	{ id: "100k-400k", label: "100,000 to 400,000" },
	{ id: "400k-1m", label: "400,000 to 1 million" },
	{ id: "1m-5m", label: "1 to 5 million" },
	{ id: "over-5m", label: "Over 5 million" },
];

export const CUSTOM_EMAIL_RANGES = [
	{ id: "under-500k", label: "Under 500,000" },
	{ id: "500k-2m", label: "500,000 to 2 million" },
	{ id: "2m-10m", label: "2 to 10 million" },
	{ id: "10m-50m", label: "10 to 50 million" },
	{ id: "over-50m", label: "Over 50 million" },
];

// Things a bigger customer may ask for. The ticks tell us what to build first: ticking one promises nothing, and the page
// says so. "other" comes with a free-text line.
export const CUSTOM_NEEDS = [
	{ id: "sso", label: "SSO/SAML" },
	{ id: "soc2", label: "SOC 2 report" },
	{ id: "audit-logs", label: "Audit logs" },
	{ id: "scim", label: "SCIM" },
	{ id: "dpa-security", label: "DPA and security review" },
	{ id: "sla", label: "Uptime SLA" },
	{ id: "invoicing", label: "Invoicing or purchase order" },
	{ id: "seats", label: "Team seats and roles" },
	{ id: "newsletters", label: "More newsletters per account" },
	{ id: "cohort-sends", label: "Random cohort sends" },
	{ id: "warmup", label: "Hands-on IP and domain warm-up" },
	{ id: "account-manager", label: "A dedicated account manager" },
	{ id: "byo-ai-key", label: "Bring your own AI key" },
	{ id: "other", label: "Other" },
];

export const CUSTOM_TIMELINES = [
	{ id: "this-month", label: "This month" },
	{ id: "this-quarter", label: "This quarter" },
	{ id: "exploring", label: "Just exploring" },
];

export const CUSTOM_STATUSES = [
	{ id: "new", label: "New" },
	{ id: "contacted", label: "Contacted" },
	{ id: "won", label: "Won" },
	{ id: "lost", label: "Lost" },
];

export const CUSTOM_LIMITS = { name: 100, company: 120, website: 200, otherNeed: 300, message: 2000, notes: 4000 };

// Kept while the conversation lasts and this long after the last change (lib/legal.js, the privacy policy).
export const CUSTOM_RETENTION_YEARS = 2;

export const CUSTOM_REPLY_WITHIN = "2 business days";

export const CUSTOM_BUTTON = "Tell us what you need";

export const choiceIds = (choices) => choices.map(({ id }) => id);

export const choiceLabel = (choices, id) => choices.find((choice) => choice.id === id)?.label ?? null;
