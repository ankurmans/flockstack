// Where each kind of data is stored on FlockStack Cloud, for /docs/regions and /llms-full.txt. It says "stored in the
// European Union" and claims no more: not everything below is limited to it, and the list of what leaves is part of the
// page. Each place is a fact about the deployment in wrangler.jsonc; change them together.
export const REGION_DATA = [
	{
		what: "Your account, newsletters, website pages and navigation, contacts, campaigns, issues and their tags, signup forms and their optional after-signup steps and the daily counts of their views and signups, the daily counts of website visits, readers' comments and display names, sending history, API key hashes and sessions, provisional agent drafts, team seats and roles, Stripe import mappings, stored plain-text replies, guest author profiles, paid subscriber perks and optional mailing list choices and monthly metered read histories, internal link metadata, audience blocks in issue content and automation email variant delivery records, private referral code inventory and fulfillment receipts, complimentary gifts, gift redemption receipts and paid-trial fee settings and readers’ supporter-badge choices, opted-in creator matching profiles and each account’s own private conversation and message copies, direct sponsor emails and brand names, placement inventory and planned commercial dates and prices, sponsor creative and human approval, Stripe sponsorship invoice references and observed amounts and currencies, actual containing-message delivery and click observations, group buyer and recipient addresses, group seat invitations and consent dates, funded access periods and separate personal paid-access snapshots, group Stripe checkout, customer and subscription references, normalized subscription financial snapshots, change observations, invoice amounts and currencies, Stripe source IDs and observation dates",
		us: "A Cloudflare D1 database. Cloudflare chooses where it runs.",
		eu: "A Cloudflare D1 database with the EU jurisdiction, which keeps its data in the EU.",
	},
	{ what: "Optional Reply Rules comment classification", us: "Owner and reader consent are required. Comment text, public rules and bounded consenting manually hidden examples go to Workers AI globally with gateway logging and caching off. Rules, consent and reviewable decision metadata stay with newsletter/comment records in D1.", eu: "Owner and reader consent are required. Comment text, public rules and bounded consenting manually hidden examples may be processed outside the EU by Workers AI, with gateway logging and caching off. Rules, consent and reviewable decision metadata stay in EU D1." },
	{ what: "Incoming newsletter replies", us: "Cloudflare Email Routing and an Email Worker process incoming mail on Cloudflare’s network; plain text is stored in the US app database.", eu: "Cloudflare Email Routing and an Email Worker process incoming mail on Cloudflare’s network, which is not confined to the EU; plain text is stored in the EU app database." },
	{
		what: "Custom plan requests: what you type into the request form at /custom",
		us: "A Cloudflare D1 database. Cloudflare chooses where it runs.",
		eu: "A Cloudflare D1 database with the EU jurisdiction, which keeps its data in the EU. A request is stored in the region whose address you sent it to.",
	},
	{
		what: "Pictures you upload or generate, which your issues and websites show",
		us: "A public Cloudflare R2 bucket, served by Cloudflare's network.",
		eu: "A public Cloudflare R2 bucket with the EU jurisdiction, served by Cloudflare's network.",
	},
	{
		what: "Product files you sell, original sponsor images, and your account exports",
		us: "Private Cloudflare R2 buckets. Product files and exports leave through signed, expiring links, or a paid perk download that checks the reader session and current tier each time. Sponsor images are private until uploader consent and human owner approval make a selected image public immediately; approved public images remain available to sent issues until account deletion and can be publicly cached for five minutes. Private previews require the creator session or the sponsor’s current private management link.",
		eu: "Private Cloudflare R2 buckets with the EU jurisdiction. Product files and exports leave through signed, expiring links, or a paid perk download that checks the reader session and current tier each time. Sponsor images are private until uploader consent and human owner approval make a selected image public immediately; approved public images remain available to sent issues until account deletion and can be publicly cached for five minutes. Private previews require the creator session or the sponsor’s current private management link.",
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
		what: "Optional reader-requested issue translations: only the authored text the signed-in subscriber may read",
		us: "Cloudflare Workers AI, on its global network, with gateway logging and caching off. Translated text is cached privately in D1 for seven days; no contact records or session identifiers are added to the model request.",
		eu: "Cloudflare Workers AI, on its global network, so the authored text may be processed outside the EU. Gateway logging and caching are off. The private seven-day translation cache stays in D1 with the EU jurisdiction; no contact records or session identifiers are added to the request.",
	},
	{
		what: "Optional account-assistant conversations, selected private brief/draft text and bounded redacted tool results",
		us: "Cloudflare Workers AI on its global network, with gateway logging and caching off. No server chat transcript. Grant metadata, counts and ordinary action records stay in D1.",
		eu: "Cloudflare Workers AI on its global network, so this text may be processed outside the EU, with gateway logging and caching off. No server chat transcript. Grant metadata, counts and ordinary action records stay in EU D1.",
	},
	{
		what: "Optional AI image descriptions and generated images",
		us: "Cloudflare Workers AI, on its global network, with gateway logging and caching off. The image is kept in the ordinary public image store; the model and date in D1, never the description.",
		eu: "Cloudflare Workers AI, on its global network, so descriptions and generated images may be processed outside the EU. Gateway logging and caching are off. The image is kept in the public EU R2 image bucket and served globally; model and date in EU D1, never the description.",
	},
	{
		what: "Logs",
		us: "Cloudflare's Workers logs.",
		eu: "Cloudflare's Workers logs, which aren't limited to the EU.",
	},
];

// What isn't kept in the region, in the order a reader would worry about it.
export const REGION_LEAVES = [
	"Automatic brand domain setup. When you request it, Cloudflare receives the domain names and their DNS records. The account-to-zone configuration is kept by the server operator; no subscriber data is sent for DNS setup.",
	"Where the code runs. A request is handled by the Cloudflare data center closest to the visitor, which can be outside the region. Nothing is stored there, but the request passes through it.",
	"Pictures in Cloudflare's cache. A public picture is cached near the readers who load it, wherever they are.",
	"Email in transit. Mail goes to the recipients' own servers, wherever those are.",
	"Webhooks. The events go to the addresses you add, wherever those servers are, Zapier's and Make's included. Web issue, comment, incoming-reply, contact-deletion and Reply Rules lifecycle events contain record IDs only, without private text or email addresses. Stable event IDs and the delivery log stay in the region's database.",
	"Private editorial collaboration. Private CRDT checkpoints stay in the regional database. Optional Cloudflare Durable Object namespaces are separate per regional Worker; EU objects use an EU-jurisdiction namespace, and elsewhere Cloudflare chooses the object location. The regional database also holds private editorial threads and mentions. Editor snapshots expire after 30 days without a checkpoint; idle object copies expire after a day. Account exports include both, and account deletion purges both stores.",
	"Reader billing choices. Native pause schedules, once-only save-offer history and current billing observations stay in the account region. Optional cancellation feedback stays private to the creator, is never sent to Stripe and is deleted with the reader profile. Account exports include these records; account deletion removes them.",
	"Billing. Polar and Stripe hold your name, email address and payment details under their own terms. The region's database keeps their customer and subscription IDs and your plan's status.",
	"Logs. Cloudflare keeps the Workers logs. They hold request details and FlockStack's own log lines: errors, IDs and event types, and a line for each sign-in with the email address, IP address and browser.",
	"Alerts to the FlockStack team. They name account IDs and never email content. A Custom plan request's alert names the company and what it asked for, not the person. They go by email, and to Telegram when it is set up.",
	"Product analytics. One PostHog project on PostHog US Cloud serves both regions, so what it collects from eu.flockstack.io, after a visitor accepts, is processed in the United States.",
	"The support assistant. It runs on Cloudflare Workers AI, which runs on Cloudflare's global network, so what you type to it may be processed outside the region. FlockStack stores none of it: the conversation stays in your browser tab.",
	"Audio versions. The text of an issue you turn into audio goes to ElevenLabs in the United States, from either region, only when you click Create audio version. The finished file stays in the region.",
	"Optional issue translations. A signed-in reader can request a translation of only the authored text they may read. Workers AI processes it on Cloudflare's global network, possibly outside the region. The private translation cache expires after seven days.",
	"The account assistant. After explicit owner consent, conversation, selected private brief/draft text and bounded redacted tool results go to Workers AI, possibly outside the region. No server transcript is kept; the actual tools retain their ordinary records in the account’s region.",
	"Reply Rules. Owner- and reader-consented comment text, public rules and bounded consenting manually hidden examples go to Workers AI, possibly outside the region. Decisions remain reviewable. No names, emails or identifiers are added.",
	"AI images. An explicit generation request sends the creator’s description to Workers AI, possibly outside the region, with gateway logging and caching off. The result is an ordinary public image, served globally; FlockStack does not store the description.",
	"The AI writing tools. They run on Cloudflare Workers AI, which runs on Cloudflare's global network, so the text you select, or the draft you ask about, may be processed outside the region. No subscriber's data is sent, and FlockStack stores only a count of requests per day.",
	"Unsplash, if the server has a key for its free photos. Your search words go to it, and a photo used in an issue loads from Unsplash's servers when a reader opens the issue.",
	"GIPHY, if the server has a key for its GIFs. Your search words go to it, and a GIF used in an issue loads from GIPHY's servers when a reader opens the issue.",
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
