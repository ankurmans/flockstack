import "server-only";
import { MAX_ACTIVE_API_KEYS } from "@/lib/actions/api-keys";
import { ERRORS } from "@/lib/actions/errors";
import { API_BASE_PATH, REQUESTS_PER_KEY } from "@/lib/api/rest";
import { API_KEY_SCAN_REGEX } from "@/lib/api-key-tokens";
import { CHANGELOG_SUMMARY } from "@/lib/changelog";
import { APP_NAME, isCloud } from "@/lib/config";
import { getMcpClients, getMcpConnectors, getMcpUrl } from "@/lib/docs/mcp-clients";
import { getAudienceGuideMarkdown } from "@/lib/docs/audience-guide";
import { getRegionsMarkdown } from "@/lib/docs/regions";
import { getWarningsMarkdown } from "@/lib/docs/warnings";
import { getEndpointGroups } from "@/lib/docs/reference";
import { formatNumber, formatUsd, formatUsdCents } from "@/lib/format";
import { getPublishedLegalPages } from "@/lib/legal";
import { DEDICATED_IP_PLAN_IDS, EXTRA_EMAILS, FREE_PLAN, PLANS, YEARLY_MONTHS, getDedicatedIpPrice } from "@/lib/plans";
import { TAGLINE, getPageMetadata } from "@/lib/site";

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
		summary: "API keys, their two levels and the rate limits.",
		description: "FlockStack API keys: full access or signups only, sent as a bearer token, with the rate limits each key and each account get.",
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
		href: "/docs/comments",
		title: "Comments",
		summary: "Readers' comments on web issues: how subscribers sign in, the rules you set, reasons and what is stored.",
		description: "How FlockStack comments work: subscribers sign in by email with no password, you set who can comment and what waits for review, and whatever you moderate has a reason its author reads.",
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

function hintsOf({ readOnly, destructive, idempotent, openWorld }) {
	return [readOnly && "read-only", destructive && "can't be undone", idempotent && "safe to repeat", openWorld && "reaches outside FlockStack"].filter(Boolean);
}

// FlockStack Cloud's prices in a line, from lib/plans.js.
function getPricingSummary() {
	const [first] = PLANS;
	const last = PLANS.at(-1);
	const free = `a Free plan at $0 (${formatNumber(FREE_PLAN.subscribers)} subscribers, ${formatNumber(FREE_PLAN.emailsPerMonth)} emails a month, a small "Sent with FlockStack" link, never billed past its limits)`;
	const plans = `${free}, then paid plans from ${formatUsd(first.monthlyPrice)} a month (${formatNumber(first.emailsPerMonth)} emails, ${formatNumber(first.subscribers)} subscribers) to ${formatUsd(last.monthlyPrice)} (${formatNumber(last.emailsPerMonth)} emails, ${formatNumber(last.subscribers)} subscribers), yearly at ${YEARLY_MONTHS} months`;
	const ipFrom = formatUsd(Math.min(...DEDICATED_IP_PLAN_IDS.map((id) => getDedicatedIpPrice(id, "month"))));
	return `${plans}; extra emails past a paid plan's at ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, up to a limit the owner sets; a dedicated IP add-on on Pro and above from ${ipFrom} a month; past the largest plan, a Custom plan with no price list: ask at /custom.`;
}

// The short index at /llms.txt (llmstxt.org).
export function getLlmsIndex(appUrl) {
	const groups = getEndpointGroups(appUrl);
	const legalPages = isCloud() ? getPublishedLegalPages() : [];
	return [
		"# FlockStack",
		"",
		`> ${TAGLINE}: a newsletter app where you pay for the emails you send, not for dormant subscribers, for a fraction of what other platforms charge. Write and schedule issues, send them to your list and publish them on the web from the dashboard, or let an AI agent do it: everything a customer does in the dashboard also works through a REST API and an MCP server, with the same checks and limits.`,
		"",
		`REST API: ${appUrl}${API_BASE_PATH}, with Authorization: Bearer <API key>. MCP server (Streamable HTTP): ${getMcpUrl(appUrl)}, same key, or OAuth for apps like ChatGPT, Claude and Grok Bot.`,
		"",
		"## Docs",
		"",
		...DOC_PAGES.map(({ href, title, summary }) => `- [${title}](${appUrl}${href}): ${summary}`),
		`- [OpenAPI document](${appUrl}${API_BASE_PATH}/openapi.json): the API as OpenAPI 3.1.`,
		`- [Full reference](${appUrl}/llms-full.txt): every endpoint and MCP tool in Markdown.`,
		"",
		// The changelog and the legal pages are about FlockStack Cloud: a self-hosted server has none.
		...(isCloud() ? ["## Changelog", "", `- [Changelog](${appUrl}/changelog): ${CHANGELOG_SUMMARY}`, ""] : []),
		...(isCloud() ? ["## Pricing", "", `- [Pricing](${appUrl}/#pricing): ${getPricingSummary()}`, ""] : []),
		...(legalPages.length > 0 ? ["## Legal", "", ...legalPages.map(({ href, title, summary }) => `- [${title}](${appUrl}${href}): ${summary}`), ""] : []),
		"## Endpoints",
		"",
		...groups.flatMap(({ group, endpoints }) => [
			`### ${group}`,
			"",
			...endpoints.map(({ method, path, name, title }) => `- [${title}](${appUrl}/docs/api#${name.replaceAll("_", "-")}): ${method} ${path} (MCP tool ${name})`),
			"",
		]),
	].join("\n");
}

function parameterLines(parameters) {
	if (parameters.length === 0) return ["No parameters."];
	return parameters.map(
		({ name, in: location, type, required, description }) =>
			`- \`${name}\` (${location}, ${type}${required ? ", required" : ""})${description ? `: ${description}` : ""}`
	);
}

// The whole reference at /llms-full.txt, for agents that read docs as text.
export function getLlmsFull(appUrl) {
	const groups = getEndpointGroups(appUrl);
	return [
		"# FlockStack API and MCP reference",
		"",
		"Everything a FlockStack customer does in the dashboard works through the REST API and the MCP server. Both run the same actions as the dashboard, with the same plan limits, sender rules, pre-send checks, paused accounts and first-send steps.",
		"",
		"## Authentication",
		"",
		`Create an API key on the dashboard's API keys page and send it as \`Authorization: Bearer <key>\` to ${appUrl}${API_BASE_PATH} or to the MCP server at ${getMcpUrl(appUrl)}.`,
		"",
		"- Full access keys can do everything below, including creating more keys. Keep them on a server or in your AI assistant's settings.",
		"- Signups only keys can only add contacts (`POST /api/v1/contacts`, MCP tool `add_contact`), for signup forms in website code. That endpoint also answers browsers (CORS).",
		`- Every key gets ${REQUESTS_PER_KEY.limit} requests a minute across REST and MCP, and some actions have their own limit, for each key and for the account: its keys, connected apps and dashboard share the account's, so more keys don't raise it. Over a limit, the answer is 429 rate_limited.`,
		`- Keys are stored hashed and shown once. Revoked keys answer 401 unauthorized. An account has up to ${MAX_ACTIVE_API_KEYS} active keys.`,
		"- Keys start with `mc_` (United States) or `mc_eu_` (European Union) followed by 43 characters of base64url. An account lives in one region and its keys only work at that region's address. To find keys in text, match `" + API_KEY_SCAN_REGEX + "`.",
		`- The MCP server also takes OAuth access tokens, for apps such as ChatGPT, Claude and Grok Bot: the user signs in to FlockStack and allows the app, which then has full access. Discovery starts at ${appUrl}/.well-known/oauth-protected-resource/mcp.`,
		"",
		"## Errors",
		"",
		"Every error answers `{ \"error\": { \"code\": \"…\", \"message\": \"…\" } }`. MCP tools answer the same object in an error result. Codes never change meaning:",
		"",
		...Object.entries(ERRORS).map(([code, { status, description }]) => `- \`${code}\` (${status}): ${description}`),
		"",
		"Sending a campaign that is already sending or sent answers `conflict`, so retrying a send never sends twice.",
		"",
		"## Tags, segments and automations",
		"",
		getAudienceGuideMarkdown(),
		"## Warnings and blocks",
		"",
		getWarningsMarkdown(),
		"## Regions",
		"",
		getRegionsMarkdown(),
		"## MCP",
		"",
		`The MCP server speaks Streamable HTTP at ${getMcpUrl(appUrl)}, without sessions. Each endpoint below is one tool with the same name, input and output; its annotations tell clients whether it's read-only, can't be undone, is safe to repeat or reaches outside FlockStack. The send tools can't be undone: ask the user before calling them.`,
		"",
		...getMcpConnectors(appUrl).flatMap(({ name, steps, note }) => [`### ${name}`, "", ...steps.map((step, index) => `${index + 1}. ${step}`), "", ...(note ? [note, ""] : [])]),
		...getMcpClients(appUrl).flatMap(({ name, file, code, note }) => [`### ${name}`, "", `${file}:`, "", "```", code, "```", "", note, ""]),
		"## Endpoints",
		"",
		...groups.flatMap(({ group, description, endpoints }) => [
			`### ${group}`,
			"",
			description,
			"",
			...endpoints.flatMap((endpoint) => [
				`#### ${endpoint.title}`,
				"",
				`\`${endpoint.method} ${endpoint.path}\` · MCP tool \`${endpoint.name}\` · ${endpoint.level}${hintsOf(endpoint.hints).length ? ` · ${hintsOf(endpoint.hints).join(", ")}` : ""}`,
				"",
				endpoint.description,
				"",
				...parameterLines(endpoint.parameters),
				"",
				"```bash",
				endpoint.curl,
				"```",
				"",
			]),
		]),
	].join("\n");
}
