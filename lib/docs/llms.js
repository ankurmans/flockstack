import "server-only";
import { MAX_ACTIVE_API_KEYS } from "@/lib/actions/api-keys";
import { ERRORS } from "@/lib/actions/errors";
import { API_BASE_PATH, REQUESTS_PER_KEY } from "@/lib/api/rest";
import { API_KEY_SCAN_REGEX } from "@/lib/api-key-tokens";
import { isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/pages";
import { getMcpClients, getMcpConnectors, getMcpUrl } from "@/lib/docs/mcp-clients";
import { getAgentSafetyMarkdown } from "@/lib/docs/agent-safety";
import { getAudienceGuideMarkdown } from "@/lib/docs/audience-guide";
import { getRegionsMarkdown } from "@/lib/docs/regions";
import { getWarningsMarkdown } from "@/lib/docs/warnings";
import { getEndpointGroups } from "@/lib/docs/reference";
import { formatNumber, formatUsd, formatUsdCents } from "@/lib/format";
import { getPublishedLegalPages } from "@/lib/legal";
import { DEDICATED_IP_PRICE, EXTRA_EMAILS, FREE_PLAN, PLANS, YEARLY_MONTHS } from "@/lib/plans";
import { TAGLINE } from "@/lib/site";

// Kept here for what imports them from this module.
export { DOC_PAGES, getDocsPageMetadata } from "@/lib/docs/pages";

function hintsOf({ readOnly, destructive, idempotent, openWorld }) {
	return [readOnly && "read-only", destructive && "can't be undone", idempotent && "safe to repeat", openWorld && "reaches outside FlockStack"].filter(Boolean);
}

// FlockStack Cloud's prices in a line, from lib/plans.js.
function getPricingSummary() {
	const [first] = PLANS;
	const last = PLANS.at(-1);
	const free = `a Free plan at $0 (${formatNumber(FREE_PLAN.subscribers)} subscribers, ${formatNumber(FREE_PLAN.emailsPerMonth)} emails a month, a small "Sent with FlockStack" link, never billed past its limits)`;
	const plans = `${free}, then paid plans from ${formatUsd(first.monthlyPrice)} a month (${formatNumber(first.emailsPerMonth)} emails, ${formatNumber(first.subscribers)} subscribers) to ${formatUsd(last.monthlyPrice)} (${formatNumber(last.emailsPerMonth)} emails, ${formatNumber(last.subscribers)} subscribers), yearly at ${YEARLY_MONTHS} months`;
	return `${plans}; extra emails past a paid plan's at ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, up to a limit the owner sets; a dedicated IP add-on on Pro and above at cost, ${formatUsd(DEDICATED_IP_PRICE)} a month with no markup; past the largest plan, a Custom plan with no price list: ask at /custom.`;
}

// The short index at /llms.txt (llmstxt.org).
// docsOnly: the part the marketing website's /llms.txt merges after its own (app/llms-docs.txt/route.js): no title, summary,
// changelog or pricing, which are the website's.
export function getLlmsIndex(appUrl, { docsOnly = false } = {}) {
	const groups = getEndpointGroups(appUrl);
	const legalPages = isCloud() ? getPublishedLegalPages() : [];
	return [
		...(docsOnly ? [] : ["# FlockStack", "", `> ${TAGLINE}: a newsletter app where you pay for the emails you send, not for dormant subscribers, for a fraction of what other platforms charge. Write and schedule issues, send them to your list and publish them on the web from the dashboard, or let an AI agent do it: everything a customer does in the dashboard also works through a REST API and an MCP server, with the same checks and limits.`, ""]),
		`REST API: ${appUrl}${API_BASE_PATH}, with Authorization: Bearer <API key>. MCP server (Streamable HTTP): ${getMcpUrl(appUrl)}, same key, or OAuth for apps like ChatGPT, Claude and Grok Bot.`,
		"",
		"## Docs",
		"",
		...DOC_PAGES.map(({ href, title, summary }) => `- [${title}](${appUrl}${href}): ${summary}`),
		`- [OpenAPI document](${appUrl}${API_BASE_PATH}/openapi.json): the API as OpenAPI 3.1.`,
		`- [Full reference](${appUrl}/llms-full.txt): every endpoint and MCP tool in Markdown.`,
		"",
		// The changelog, pricing and legal pages are about FlockStack Cloud: a self-hosted server has none. The changelog and
		// pricing are the marketing website's pages (worker-entry.mjs forwards them).
		...(isCloud() && !docsOnly ? ["## Changelog", "", `- [Changelog](${appUrl}/changelog): What changed in FlockStack Cloud, newest first.`, ""] : []),
		...(isCloud() && !docsOnly ? ["## Pricing", "", `- [Pricing](${appUrl}/pricing): ${getPricingSummary()}`, ""] : []),
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
		"- A key has a level: `read_only` (reads), `drafts` (also writes drafts that don't go out), `send_with_approval` (also changes settings and contacts; its sends, schedules and deletes wait for the owner's approval), `full` (everything, including creating more keys) and `signups` (only adds contacts). A call its level doesn't allow answers 403 forbidden, and MCP lists only the tools a key can run. Keep full access keys on a server or in your AI assistant's settings.",
		"- Signups only keys can only add contacts (`POST /api/v1/contacts`, MCP tool `add_contact`), for signup forms in website code. That endpoint also answers browsers (CORS).",
		"- A key can be limited to one newsletter, capped at a number of calls a day (429 daily_cap_reached past it) and set to expire (401 unauthorized after).",
		"- An action in the send or delete class from a send_with_approval key or app, or on a newsletter set to ask before an agent sends, does not run: it answers 202 (REST) or a tool result (MCP) with `status: approval_required`, an `approvalId` and `retryAfter`. Do not repeat the call: poll `get_approval_status` or wait for the `approval.decided` webhook. Only the account owner can approve, in the dashboard.",
		`- Every key gets ${REQUESTS_PER_KEY.limit} requests a minute across REST and MCP, and some actions have their own limit, for each key and for the account: its keys, connected apps and dashboard share the account's, so more keys don't raise it. Over a limit, the answer is 429 rate_limited.`,
		`- Keys are stored hashed and shown once. Revoked keys answer 401 unauthorized. An account has up to ${MAX_ACTIVE_API_KEYS} active keys.`,
		"- Keys start with `mc_` (United States) or `mc_eu_` (European Union) followed by 43 characters of base64url. An account lives in one region and its keys only work at that region's address. To find keys in text, match `" + API_KEY_SCAN_REGEX + "`.",
		`- The MCP server also takes OAuth access tokens, for apps such as ChatGPT, Claude and Grok Bot: the user signs in to FlockStack and picks what the app may do, at the levels above, up to the scope it asked for (flockstack:read, flockstack:drafts, flockstack:send, flockstack:full). Discovery starts at ${appUrl}/.well-known/oauth-protected-resource/mcp.`,
		"",
		"## Errors",
		"",
		"Every error answers `{ \"error\": { \"code\": \"…\", \"message\": \"…\" } }`. MCP tools answer the same object in an error result. Codes never change meaning:",
		"",
		...Object.entries(ERRORS).map(([code, { status, description }]) => `- \`${code}\` (${status}): ${description}`),
		"",
		"Sending a campaign that is already sending or sent answers `conflict`, so retrying a send never sends twice.",
		"",
		"## Agent safety",
		"",
		getAgentSafetyMarkdown(appUrl),
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
