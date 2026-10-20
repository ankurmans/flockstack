// Where each kind of data is stored on FlockStack Cloud, for /docs/regions and /llms-full.txt. It says "stored in the
// European Union" and claims no more: not everything below is limited to it, and the list of what leaves is part of the
// page. Each place is a fact about the deployment in wrangler.jsonc; change them together.
export const REGION_DATA = [
	{
		what: "Your account, newsletters, website pages and navigation, contacts, campaigns, issues and their tags, signup forms and the daily counts of their views and signups, the daily counts of website visits, readers' comments and display names, sending history, API key hashes and sessions",
		us: "A Cloudflare D1 database. Cloudflare chooses where it runs.",
		eu: "A Cloudflare D1 database with the EU jurisdiction, which keeps its data in the EU.",
	},
	{
		what: "Custom plan requests: what you type into the request form at /custom",
		us: "A Cloudflare D1 database. Cloudflare chooses where it runs.",
		eu: "A Cloudflare D1 database with the EU jurisdiction, which keeps its data in the EU. A request is stored in the region whose address you sent it to.",
	},
	{
		what: "Pictures you upload, which your issues and websites show",
		us: "A public Cloudflare R2 bucket, served by Cloudflare's network.",
		eu: "A public Cloudflare R2 bucket with the EU jurisdiction, served by Cloudflare's network.",
	},
	{
		what: "Product files you sell, and your account exports",
		us: "Private Cloudflare R2 buckets. Files leave them only through a signed, expiring link.",
		eu: "Private Cloudflare R2 buckets with the EU jurisdiction. Files leave them only through a signed, expiring link.",
	},
	{
		what: "Sending: each email's recipient and content, and FlockStack's own sign-in codes",
		us: "Amazon SES in us-east-2 (Ohio).",
		eu: "Amazon SES in eu-west-1 (Ireland).",
	},
	{
		what: "Background jobs: sending batches, schedules and exports",
		us: "Upstash QStash in its US region. Jobs carry IDs and counts, not email content.",
		eu: "Upstash QStash in its EU region. Jobs carry IDs and counts, not email content.",
	},
	{
		what: "Your FlockStack plan and its payments",
		us: "Polar or Stripe, whichever bills the plan. One account serves both regions.",
		eu: "Polar or Stripe, whichever bills the plan. One account serves both regions.",
	},
	{
		what: "What you sell to readers",
		us: "Your own Stripe account, which you connect. FlockStack takes no cut.",
		eu: "Your own Stripe account, which you connect. FlockStack takes no cut.",
	},
	{
		what: "Product analytics on FlockStack's own pages: page views, clicks, device, approximate location and, when you are signed in, your user ID, email address and plan",
		us: "PostHog US Cloud. It is never on a newsletter's pages or the pages readers use.",
		eu: "The same PostHog project on PostHog US Cloud, so the events are processed in the United States. It runs only after a visitor accepts, and never on a newsletter's pages or the pages readers use.",
	},
	{
		what: "The text of an issue you turn into an audio version, and the audio made from it",
		us: "The text goes to ElevenLabs in the United States; the finished MP3 is kept in a private Cloudflare R2 bucket and played through your newsletter's website.",
		eu: "The text goes to ElevenLabs in the United States, so it leaves the EU; the finished MP3 is kept in a private Cloudflare R2 bucket with the EU jurisdiction and played through your newsletter's website.",
	},
	{
		what: "The support assistant's messages",
		us: "Cloudflare Workers AI, on Cloudflare's global network.",
		eu: "Cloudflare Workers AI, on Cloudflare's global network, so its messages may be processed outside the EU.",
	},
	{
		what: "The text you send to the AI writing tools: the passage you selected or the issue's draft",
		us: "Cloudflare Workers AI, on Cloudflare's global network. FlockStack keeps a count of requests, not the text.",
		eu: "Cloudflare Workers AI, on Cloudflare's global network, so the text may be processed outside the EU. FlockStack keeps a count of requests, not the text.",
	},
	{
		what: "Logs",
		us: "Cloudflare's Workers logs.",
		eu: "Cloudflare's Workers logs, which aren't limited to the EU.",
	},
];

// What isn't kept in the region, in the order a reader would worry about it.
export const REGION_LEAVES = [
	"Where the code runs. A request is handled by the Cloudflare data center closest to the visitor, which can be outside the region. Nothing is stored there, but the request passes through it.",
	"Pictures in Cloudflare's cache. A public picture is cached near the readers who load it, wherever they are.",
	"Email in transit. Mail goes to the recipients' own servers, wherever those are.",
	"Webhooks. The events go to the addresses you add, wherever those servers are, Zapier's and Make's included. The delivery log stays in the region's database.",
	"Billing. Polar and Stripe hold your name, email address and payment details under their own terms. The region's database keeps their customer and subscription IDs and your plan's status.",
	"Logs. Cloudflare keeps the Workers logs. They hold request details and FlockStack's own log lines: errors, IDs and event types, and a line for each sign-in with the email address, IP address and browser.",
	"Alerts to the FlockStack team. They name account IDs and never email content. A Custom plan request's alert names the company and what it asked for, not the person. They go by email, and to Telegram when it is set up.",
	"Product analytics. One PostHog project on PostHog US Cloud serves both regions, so what it collects from eu.flockstack.io, after a visitor accepts, is processed in the United States.",
	"The support assistant. It runs on Cloudflare Workers AI, which runs on Cloudflare's global network, so what you type to it may be processed outside the region. FlockStack stores none of it: the conversation stays in your browser tab.",
	"Audio versions. The text of an issue you turn into audio goes to ElevenLabs in the United States, from either region, only when you click Create audio version. The finished file stays in the region.",
	"The AI writing tools. They run on Cloudflare Workers AI, which runs on Cloudflare's global network, so the text you select, or the draft you ask about, may be processed outside the region. No subscriber's data is sent, and FlockStack stores only a count of requests per day.",
	"Unsplash, if the server has a key for its free photos. Your search words go to it, and a photo used in an issue loads from Unsplash's servers when a reader opens the issue.",
	"Google or Apple, when you sign in with one of them.",
];

export function getRegionsMarkdown() {
	return [
		"FlockStack Cloud runs as two deployments of the same code, each with its own database and storage: the United States at flockstack.io and the European Union at eu.flockstack.io. You choose where your data is stored when you sign up. An account lives in one region: its sign-in, API keys and passkeys work at that region's address only, and accounts can't be looked up or moved between regions. Recommendations between newsletters work only inside a region.",
		"",
		"API keys start with `mc_` in the United States and `mc_eu_` in the European Union.",
		"",
		"### Where each kind of data is stored",
		"",
		...REGION_DATA.flatMap(({ what, us, eu }) => [`- ${what}. United States: ${us} European Union: ${eu}`]),
		"",
		"### What isn't kept in the region",
		"",
		...REGION_LEAVES.map((item) => `- ${item}`),
		"",
	].join("\n");
}
