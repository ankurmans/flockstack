import { SES_REGIONS } from "./legal.js";

// The services that can touch personal data on FlockStack Cloud, for /sub-processors. Each place is a fact about the
// deployment (wrangler.jsonc, README, Regions) and the code that calls the service; change them together. The wording
// follows lib/docs/regions.js: "stored in the EU", never more than the list of what leaves the region allows.
export const SUBPROCESSORS = [
	{
		name: "Cloudflare",
		link: "https://www.cloudflare.com/gdpr/subprocessors/",
		purpose: "Runs the app (Workers), stores the database (D1) and files (R2), serves and caches public images, and keeps the Workers logs.",
		data: "Everything in an account, subscriber lists and issues included. In the logs: request details, IP addresses, and a line per sign-in with the email address and browser.",
		us: "D1 and R2 where Cloudflare chooses. The code runs in the data center closest to the visitor. Logs aren't limited to a region.",
		eu: "D1 and R2 with the EU jurisdiction, which keeps their data in the EU. The code runs in the data center closest to the visitor, and logs aren't limited to the EU.",
	},
	{
		name: "Amazon SES (Amazon Web Services)",
		link: "https://aws.amazon.com/compliance/sub-processors/",
		purpose: "Sends every email: newsletters to subscribers, and FlockStack's own sign-in codes, alerts and export links. Reports deliveries, bounces and complaints back through Amazon SNS.",
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
		purpose: "Bills FlockStack plans: checkout, subscriptions, invoices and the customer portal.",
		data: "The account holder's email address, billing and payment details, and the plan. Our database keeps their customer and subscription IDs and the plan's status.",
		us: "Polar's own locations. One Polar account serves both regions.",
		eu: "Polar's own locations. One Polar account serves both regions.",
	},
	{
		name: "Stripe",
		link: "https://stripe.com/privacy",
		purpose: "Takes payments from readers for what a creator sells, through Stripe Connect, when the creator turns selling on. Can bill FlockStack plans instead of Polar on a server set up that way.",
		data: "A buyer's name, email address and payment details, paid to the creator's own Stripe account. FlockStack gets the order: email, name, product and amount. FlockStack takes no fee on it.",
		us: "Stripe's own locations. One Stripe account serves both regions.",
		eu: "Stripe's own locations. One Stripe account serves both regions.",
	},
];

// Off unless the person running the server sets them up (README, Optional).
export const OPTIONAL_SUBPROCESSORS = [
	{
		name: "Google",
		link: "https://policies.google.com/privacy",
		purpose: "Sign in with Google. Google Postmaster Tools, which a FlockStack admin can connect to read Gmail's spam rates for the sending domain.",
		data: "For sign-in, the email address Google has verified. Postmaster Tools reads statistics and sends nothing about subscribers.",
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
