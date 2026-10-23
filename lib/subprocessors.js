import { SES_REGIONS, getElevenLabsStatus } from "./legal.js";

// Creator-chosen external content is loaded by the reader's browser, not sent through FlockStack's database.
export const WEBSITE_ICON_NOTICE = "Website icons load from the website linked by the creator, with Google's favicon service as a fallback. The image host receives the browser's request, including its IP address. Icon requests omit the page's referrer.";

// The services that can touch personal data on FlockStack Cloud, for /sub-processors. Each place is a fact about the
// deployment (wrangler.jsonc, README, Regions) and the code that calls the service; change them together. The wording
// follows lib/docs/regions.js: "stored in the EU", never more than the list of what leaves the region allows.
export const SUBPROCESSORS = [
	{
		name: "Cloudflare",
		link: "https://www.cloudflare.com/gdpr/subprocessors/",
		purpose: "Runs the app (Workers), stores the database (D1) and files (R2), serves and caches public images, keeps the Workers logs, runs the support assistant on Workers AI through AI Gateway with its logging turned off, and the editor's AI writing tools the same way, serves newsletters' websites on creators' own domains with their certificates (Cloudflare for SaaS), and holds the DNS records of shared sending addresses.",
		data: "Everything in an account, subscriber lists, issues and readers' comments included. In the logs: request details, IP addresses, and a line per sign-in with the email address and browser. The messages typed to the support assistant, with the conversation before them, while it writes an answer. The text a creator selects in the editor, or the draft of an issue, while an AI writing tool answers. The website domains creators add.",
		us: "D1 and R2 where Cloudflare chooses. The code runs in the data center closest to the visitor. Logs aren't limited to a region. Workers AI runs on Cloudflare's global network.",
		eu: "D1 and R2 with the EU jurisdiction, which keeps their data in the EU. The code runs in the data center closest to the visitor, and logs aren't limited to the EU. Workers AI runs on Cloudflare's global network, so the messages typed to the support assistant and the text sent to the AI writing tools may be processed outside the EU.",
	},
	{
		name: "Amazon SES (Amazon Web Services)",
		link: "https://aws.amazon.com/compliance/sub-processors/",
		purpose: "Sends every email: newsletters to subscribers, and FlockStack's own sign-in codes, alerts, export links, the confirmation of a Custom plan request and the support conversations people choose to email to support. Reports deliveries, bounces and complaints back through Amazon SNS.",
		data: "Recipients' email addresses, sender details, the content of each email and delivery events.",
		us: `Amazon SES in ${SES_REGIONS.us} (Ohio). A subscriber's email is sent by SES in the region of the creator's account.`,
		eu: `Amazon SES in ${SES_REGIONS.eu} (Ireland). A subscriber's email is sent by SES in the region of the creator's account.`,
	},
	{
		name: "Upstash QStash",
		link: "https://upstash.com/docs/qstash",
		purpose: "Background jobs: sending batches, scheduled sends, automations, exports and account deletion.",
		data: "IDs and counts, not email content.",
		us: "QStash in its US region.",
		eu: "QStash in its EU region.",
	},
	{
		name: "Polar",
		link: "https://polar.sh/legal/privacy",
		purpose: "Bills FlockStack plans and add-ons: checkout, subscriptions, invoices, extra emails by usage and the customer portal.",
		data: "The account holder's email address, billing and payment details, and the plan. For extra emails past a plan's, the account ID and how many were sent each month, never who they went to. Our database keeps their customer and subscription IDs and the plan's status.",
		us: "Polar's own locations. One Polar account serves both regions.",
		eu: "Polar's own locations. One Polar account serves both regions.",
	},
	{
		name: "Stripe",
		link: "https://stripe.com/privacy",
		purpose: "Takes payments from readers for what a creator sells, through Stripe Connect, when the creator turns selling on. Can bill FlockStack plans instead of Polar on a server set up that way.",
		data: "A buyer's name, email address and payment details, paid to the creator's own Stripe account. FlockStack gets the order: email, name, product and amount. FlockStack takes no fee on it. A reader who pledges saves a card on the creator's Stripe account with nothing charged; FlockStack keeps the email, the price pledged and the IDs of the Stripe customer and card. A gift buyer pays the same way; FlockStack keeps the buyer's and the recipient's emails, the message and the amount.",
		us: "Stripe's own locations. One Stripe account serves both regions.",
		eu: "Stripe's own locations. One Stripe account serves both regions.",
	},
	{
		name: "PostHog",
		link: "https://posthog.com/privacy",
		purpose: "FlockStack's own product analytics, to see how people use FlockStack's pages. Only on those pages: the home page, the product, pricing, comparison, migration and blog pages, the docs, the legal pages, sign-in and the dashboard. Never on a newsletter's public pages or the pages readers use. It uses its own cookies or local storage. One PostHog project serves both flockstack.io and eu.flockstack.io.",
		data: "Page views, clicks and actions, device and browser, approximate location, and for signed-in people the user ID, email address and plan. Session recording is off. Never a newsletter's content or a subscriber's data.",
		us: "PostHog US Cloud. It runs unless the visitor declines in Cookie settings; visitors in the EU, the EEA, the UK and Switzerland are asked first. A Global Privacy Control or Do Not Track signal turns it off.",
		eu: "The same PostHog project on PostHog US Cloud, so events from eu.flockstack.io are processed in the United States, not in the EU. It runs only after the visitor accepts. A Global Privacy Control or Do Not Track signal turns it off.",
	},
	{
		name: "ElevenLabs",
		link: "https://elevenlabs.io/privacy-policy",
		purpose: `Turns the text of an issue into speech, for its audio version, only when a writer chooses to create one. ${getElevenLabsStatus()}`,
		data: "The text of the issue a writer chooses to convert, as the voice reads it (no pictures), and the voice picked. Never a subscriber's email address or other list data. ElevenLabs keeps each request in its history, which it needs to keep a voice steady from one part to the next, under its own retention terms: its data processing agreement lets it delete customer content after 180 days of inactivity, without promising to.",
		us: "ElevenLabs in the United States.",
		eu: "The same: the text goes to ElevenLabs in the United States, not in the EU, from either region.",
	},
];

// Off unless the person running the server sets them up (README, Optional).
export const OPTIONAL_SUBPROCESSORS = [
	{
		name: "Google (sign-in)",
		link: "https://policies.google.com/privacy",
		purpose: "An optional way to sign in: Sign in with Google.",
		data: "Google receives the sign-in request and the person's choice to sign in. FlockStack gets the email address Google has verified.",
		us: "Google's own locations.",
		eu: "Google's own locations.",
	},
	{
		name: "Apple (sign-in)",
		link: "https://www.apple.com/legal/privacy/",
		purpose: "An optional way to sign in: Sign in with Apple.",
		data: "Apple receives the sign-in request and the person's choice to sign in. FlockStack gets an Apple user ID, the email address Apple has verified, which can be a private relay address that Apple forwards to the person's inbox, and, the first time only, the name if the person chooses to share it.",
		us: "Apple's own locations.",
		eu: "Apple's own locations.",
	},
	{
		name: "Unsplash",
		link: "https://unsplash.com/privacy",
		purpose: "An optional picker for free photos in the editor, when the server has an Unsplash key. A photo used in an issue is loaded from Unsplash's servers, as Unsplash's API terms require.",
		data: "The words a creator searches for. When a reader's email app or browser loads an issue's Unsplash photo, Unsplash's servers see the request and the reader's IP address, as any image host does.",
		us: "Unsplash's own locations.",
		eu: "Unsplash's own locations, so those requests are processed outside the EU.",
	},
	{
		name: "Google Postmaster Tools",
		link: "https://policies.google.com/privacy",
		purpose: "A FlockStack admin can connect it to read Gmail's spam rates for the sending domain.",
		data: "Statistics only. Nothing about subscribers is sent to Google.",
		us: "Google's own locations.",
		eu: "Google's own locations.",
	},
	{
		name: "Telegram",
		link: "https://telegram.org/privacy",
		purpose: "Alerts to the FlockStack team when something needs a person: an account block, a failing job or webhook.",
		data: "Account IDs and the alert's text. For a spam-trap block, the address that bounced. Never an email's content.",
		us: "Telegram's own locations. One chat serves both regions.",
		eu: "Telegram's own locations. One chat serves both regions.",
	},
	{
		name: "Upstash Redis",
		link: "https://upstash.com/",
		purpose: "Shared rate-limit counters. Without it they are counted in the region's database.",
		data: "Counters keyed by IP address or email inbox and the form they limit.",
		us: "The Redis database's region.",
		eu: "The Redis database's region.",
	},
	{
		name: "Vercel",
		link: "https://vercel.com/legal/privacy-policy",
		purpose: "A small DNS helper that publishes the records for shared sending addresses, like a newsletter's name on flockstack.io.",
		data: "A newsletter's address name and its DNS records. No subscriber data.",
		us: "Vercel's own locations.",
		eu: "Vercel's own locations.",
	},
];
