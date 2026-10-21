import { APP_NAME } from "@/lib/config";
import { getPageMetadata } from "@/lib/site";

// The docs' pages, in a module with next to no imports: every docs page, the sitemap and the docs' layout read this list, and
// lib/docs/llms.js, which writes the llms files from the whole action registry, would load the registry for each of them.
// summary: a line in the docs' index for agents (llms.txt). description: what search results show under the title.
export const DOC_PAGES = [
	{
		href: "/docs",
		title: "Getting started",
		summary: "Make a first request and connect an AI assistant.",
		description: "Make your first request to the FlockStack REST API with an API key, or connect ChatGPT, Claude, Cursor or Claude Code to its MCP server.",
	},
	{
		href: "/docs/authentication",
		title: "Authentication",
		summary: "API keys, their levels, caps and expiry, and the rate limits.",
		description: "FlockStack API keys: read only, drafts only, send with approval, full access or signups only, with a newsletter, a daily cap and an expiry, sent as a bearer token, and their rate limits.",
	},
	{
		href: "/docs/agent-safety",
		title: "Agent safety",
		summary: "Key levels, the approval queue (agents propose, you approve), per-newsletter keys, caps and expiry, and the agent activity log.",
		description: "Let an AI agent run your newsletter safely: read only, drafts only and send with approval keys, requests you approve before anything is sent or deleted, and a log of everything an agent did.",
	},
	{
		href: "/docs/audiences",
		title: "Tags, segments and automations",
		summary: "Tags and custom fields, merge tags, saved segments and automations.",
		description: "Label FlockStack contacts with tags and custom fields, personalize emails with merge tags, save audiences as segments to send to, and run automations that start on their own.",
	},
	{
		href: "/docs/warnings",
		title: "Warnings and blocks",
		summary: "The early warning before an automatic block, what pauses a send or blocks an account, and what to do.",
		description: "How FlockStack warns you before bounces or spam complaints block an account, the levels that pause a send or block it, why spam traps block at once, and how to bring the rates down.",
	},
	{
		href: "/docs/errors",
		title: "Errors",
		summary: "The error shape and every code.",
		description: "Every error the FlockStack REST API and MCP server can answer: one JSON shape, and each code with its HTTP status and what it means.",
	},
	{
		href: "/docs/mcp",
		title: "MCP",
		summary: "The MCP server, its tools and setup for ChatGPT, Claude, Grok Bot, Claude Code, Codex and Cursor.",
		description: "Connect FlockStack's MCP server to ChatGPT, Claude, Grok Bot, Claude Code, Codex or Cursor, and see every tool your AI agent can use.",
	},
	{
		href: "/docs/webhooks",
		title: "Webhooks",
		summary: "Signed events for subscribers, campaigns and orders: payloads, signature checks, retries and the delivery log.",
		description: "FlockStack webhooks POST signed JSON events when someone subscribes or leaves, a campaign goes out or an order is paid, retried for about 5 days.",
	},
	{
		href: "/docs/zapier-make",
		title: "Zapier and Make",
		summary: "The Zapier and Make apps: triggers from webhooks, actions for subscribers and tags, and installing them as private apps.",
		description: "Connect FlockStack to Zapier or Make: triggers for subscribers, campaigns and orders, actions to add subscribers and tags, installed as a private app.",
	},
	{
		href: "/docs/rss",
		title: "RSS feed",
		summary: "Each newsletter's feed: where it is and what it contains.",
		description: "Every FlockStack newsletter with a website has an RSS 2.0 feed with the full text of its issues, on its own domain or under the app's.",
	},
	{
		href: "/docs/export",
		title: "Export your data",
		summary: "One click or one call takes everything: contacts, issues, pictures and settings in ZIP files.",
		description: "Export everything from FlockStack in one click or one API call: contacts as CSV, every issue as Markdown and HTML with frontmatter, your pictures and a manifest. Never a paid feature.",
	},
	{
		href: "/docs/moving",
		title: "Moving from Substack, beehiiv, WordPress or Ghost",
		summary: "Import a post archive as sent issues with no email going out, and keep the old links working with redirects.",
		description: "Move your archive to FlockStack from Substack, beehiiv, WordPress or Ghost: import every published post on its original date with its pictures, and redirect the old links to the new pages.",
	},
	{
		href: "/docs/referrals",
		title: "Referrals",
		summary: "The referral program: links, rewards, what counts and what doesn't.",
		description: "How the FlockStack referral program works: each subscriber's link, rewards that unlock, merge tags for issues, and the checks that keep fake referrals out.",
	},
	{
		href: "/docs/recommendations",
		title: "Recommendations",
		summary: "Newsletters recommending each other: the signup step, the website block, the merge tag, the directory and what is counted.",
		description: "Recommend up to 10 newsletters with a pitch in your words. Readers tick the ones they want and nothing is shared otherwise. Free, with no paid placement and no cut of revenue.",
	},
	{
		href: "/docs/forms",
		title: "Forms, pop-ups and Magic Links",
		summary: "Signup forms for other sites, where subscribers came from, and how each form is counted.",
		description: "Put a FlockStack signup form on any site with one line of code or a plain HTML form, count its views and signups, and keep each subscriber's UTM parameters, referrer and channel.",
	},
	{
		href: "/docs/reports",
		title: "Reports",
		summary: "Growth by source, channel, campaign and form, issues side by side, website visits and CSV exports.",
		description: "FlockStack reports: how a newsletter grew over any range and where subscribers came from, issues compared side by side, cookieless website analytics and every table as CSV.",
	},
	{
		href: "/docs/comments",
		title: "Comments",
		summary: "Readers' comments on web issues: how subscribers sign in, the rules you set, reasons and what is stored.",
		description: "How FlockStack comments work: subscribers sign in by email with no password, you set who can comment and what waits for review, and whatever you moderate has a reason its author reads.",
	},
	{
		href: "/docs/audio",
		title: "Audio versions",
		summary: "Issues read aloud: how to make one, what is read, the characters each plan has, the player, the email link and the podcast feed.",
		description: "Turn an issue into an audio version in a voice you pick, with a player on its page, a Listen link in the email and a podcast feed, and a monthly allowance of characters on each plan.",
	},
	{
		href: "/docs/selling",
		title: "Selling",
		summary: "Digital products and paid subscriptions, paid to your own Stripe account with no cut for FlockStack.",
		description: "Sell digital products and paid subscriptions from a newsletter: Stripe Checkout on your own account, private files, expiring download links, paid issues and no cut for FlockStack.",
	},
	{
		href: "/docs/regions",
		title: "Regions",
		summary: "The United States and European Union regions: where each kind of data is stored and what leaves the region.",
		description: "FlockStack Cloud stores your data in the United States or the European Union, as you choose. Where each kind of data is stored, and what isn't kept in the region.",
	},
	{
		href: "/docs/api",
		title: "API reference",
		summary: "Every endpoint with its parameters and an example.",
		description: "Every FlockStack REST API endpoint with its parameters and a curl example: newsletters, campaigns, contacts, tags, segments, automations, domains, products, orders, payments, images and API keys.",
	},
];

// The docs' layout template doesn't reach /docs, which shares its folder, so every docs page names the docs itself.
export function getDocsPageMetadata(href) {
	const { title, description } = DOC_PAGES.find((page) => page.href === href);
	return getPageMetadata({ title: { absolute: `${title} · ${APP_NAME} docs` }, description, path: href });
}
