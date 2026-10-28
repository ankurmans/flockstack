import "server-only";
import * as z from "zod";
import { describeActionAccess, getActionClass } from "@/lib/action-scopes";
import { getPathParams } from "@/lib/actions/define-action";
import { ACTIONS, ACTION_GROUPS, getAction } from "@/lib/actions/registry";
import { API_BASE_PATH } from "@/lib/api/rest";

export const GROUP_DESCRIPTIONS = {
	"Mailing lists": "Optional reader preference lists within one publication. List targeting narrows tier and segment audiences; status and suppression always apply.",
	Perks: "Private benefits for paid readers, with tier checks on the page and every file download.",
	Authors: "Guest profiles and per-issue bylines. A byline change leaves sent emails and sender names as they were.",
	Readers: "Reader language, replies and newsletter settings.",
	Team: "Account seats and roles. Only the owner can manage access.",
	Agents: "Draft newsletter bootstrap, provisional workspaces and evidence-based writing briefs.",
	Overview: "Subscribers, email results and sends per hour, as on the dashboard's first page.",
	Newsletters: "Sender, postal address, welcome and confirmation emails, list cleanup and archive.",
	Campaigns: "Drafts, test emails, scheduling, sending, sending in steps and reports.",
	Contacts: "Search, signups, imports with checks, status changes, deletes and exports.",
	"Post import": "Moving an archive from Substack, beehiiv, WordPress, Ghost or Mailchimp: upload the export, preview it, import its posts as sent issues with no email going out.",
	"Content calendar": "Newsletter issues and LinkedIn posts planned together: items with their copy, visuals, reader problem, funnel stage and pillar, editorial batches, recurring patterns, planned days and a backlog, a calendar range that shows plans apart from real deliveries, review (the owner approves in the dashboard) and revisions. Planning never sends, schedules or publishes, and LinkedIn posts are published by hand.",
	Feeds: "Reading an RSS or Atom feed, as an issue's RSS block shows it.",
	Series: "Recurring series: an issue made from a feed's new items on a schedule, as a draft to review or sent by itself, with a history of its runs.",
	Briefings: "Briefings: a newsletter's sources read on a schedule, the stories its audience cares about picked, read and written up as a sourced draft issue with checks, on the account's own AI keys (encrypted, never shown again) and within a budget per run.",
	Templates: "Saved issues to start new ones from.",
	Snippets: "Pieces of content written once and inserted into issues from the editor.",
	Redirects: "A website's redirects: from the old addresses of imported posts, or added by hand or by CSV.",
	Segments: "Saved audiences: rules over a newsletter's contacts, with live counts, that a campaign or an automation can use, and saved lists that keep the contacts a segment matched on one day.",
	"Polls and surveys": "Polls in issues with one-click votes from email, surveys on the newsletter's website saved to custom fields, and their results.",
	Automations: "Emails, waits, tags, fields, webhooks, branches and random splits that start for a contact when they subscribe, get or lose a tag, join or leave a segment, upgrade, buy, click a link, go quiet, reach a date or are added by hand or by your code, and templates to start from.",
	"Tags and fields": "Free-form tags on contacts, and custom fields (text, number, date, date and time, true or false, lists) for merge tags, segments, automations and the preference center.",
	Domains: "Own sending domains with their DNS records, and the shared address.",
	Payments: "Whether the account can take payments, and connecting its Stripe account. FlockStack takes no cut of sales.",
	"Paid subscriptions": "A newsletter's paid settings: on or off, currency, free trial and subscribers. Campaigns can go to paid readers only.",
	Pledges: "Readers pledge a price and save a card with nothing charged; the writer converts the pledges into paid subscriptions, telling every pledger first.",
	Comps: "Paid access you give a contact by hand until a day: shown apart from paying readers and never counted as revenue.",
	Gifts: "Gift subscriptions: a reader pays once for months of a paid tier for someone else, who gets an email with a message on the day chosen and a link to redeem it.",
	Offers: "Discounts and free trials with a link, made as coupons on your Stripe account, how many readers took each, and a launch offer banner.",
	"Paid tiers": "Up to 3 paid tiers per newsletter with monthly, quarterly, yearly, lifetime and pay what you want prices, made as Products and Prices on your Stripe account. A paid issue reaches a tier and the tiers above it.",
	Fleet: "All your brands, their sending health, automatic domain setup and newsletter sending brakes.",
	Products: "Digital products readers buy once: files kept private, pages on the newsletter's site, Stripe Checkout on your own account.",
	Orders: "What readers bought, who got their download link, and resending it. Refunds are made in Stripe.",
	Images: "Pictures for campaign content, on FlockStack's CDN, kept in the account's library to use again, and files readers download from an issue.",
	"API keys": "Keys for the REST API and MCP, each with a level: read only, drafts only, send with approval, full access or signups only.",
	"Agent safety": "Requests an AI agent made that wait for the owner's approval, and the log of what keys and connected apps did. Approving or rejecting is the dashboard's: no key can.",
	Webhooks: "Addresses FlockStack POSTs events to as they happen, signed, retried for about 5 days, with a log of each delivery.",
	Billing: "Plan, usage and links to Stripe to change plan.",
	Referrals: "A referral program with rewards: settings, who referred whom, and the leaderboard.",
	Comments: "Readers' comments on the web issues: settings, moderation with reasons the author always sees, reports, and blocking a commenter.",
	"Audio versions": "Audio versions of issues read in a voice: the voices, the month's characters, making and deleting an issue's audio, and the podcast feed's settings.",
	Export: "Everything the account has in ZIP files: contacts, issues, images and settings. Never a paid feature.",
};

const EXAMPLE_ID = "6650f1c2e9b1d4a012345678";

export function toJsonSchema(schema, io = "input") {
	const { $schema, ...json } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
	return json;
}

export function getSlug(action) {
	return action.name.replaceAll("_", "-");
}

function describeType(schema = {}) {
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	const types = [schema.type, ...(schema.anyOf ?? []).map(({ type }) => type)].flat().filter(Boolean);
	if (types.includes("array")) return `${describeType(schema.items)}[]`;
	return [...new Set(types)].join(" | ") || "any";
}

// Top-level fields, plus the fields of objects and of arrays of objects one level down.
function flattenFields(schema, location, prefix = "") {
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties ?? {}).flatMap(([name, field]) => {
		const path = `${prefix}${name}`;
		const row = { name: path, in: location, type: describeType(field), required: required.has(name), description: field.description ?? "" };
		const nested = field.type === "object" ? field : field.type === "array" && field.items?.type === "object" ? field.items : null;
		if (!nested || prefix) return [row];
		const childPrefix = field.type === "array" ? `${path}[].` : `${path}.`;
		return [{ ...row, type: field.type === "array" ? "object[]" : "object" }, ...flattenFields(nested, location, childPrefix)];
	});
}

function getParameters(action) {
	const schema = toJsonSchema(action.input);
	const pathParams = new Set(getPathParams(action.http.path));
	const location = ["GET", "DELETE"].includes(action.http.method) ? "query" : "body";
	return flattenFields(schema, location).map((row) => (pathParams.has(row.name) ? { ...row, in: "path", required: true } : row));
}

function exampleValue(name) {
	const examples = { id: EXAMPLE_ID, email: "jane@example.com", newsletter: "weekly", subject: "This week", previewText: "Three links worth your time" };
	return examples[name] ?? "…";
}

function getExampleBody(action, example) {
	const parameters = getParameters(action);
	const body = Object.fromEntries(
		parameters.filter((row) => row.in === "body" && row.required && !row.name.includes(".")).map((row) => [row.name, exampleValue(row.name)])
	);
	return { ...body, ...example };
}

export function getExamplePath(action) {
	return action.http.path.replaceAll(/\{[a-zA-Z]+\}/g, EXAMPLE_ID);
}

export function getCurlExample(action, appUrl, { apiKey = "$FLOCKSTACK_API_KEY", example = action.example } = {}) {
	const isQuery = ["GET", "DELETE"].includes(action.http.method);
	const query = isQuery ? new URLSearchParams(Object.entries(example).map(([key, value]) => [key, String(value)])).toString() : "";
	const url = `${appUrl}${API_BASE_PATH}${getExamplePath(action)}${query ? `?${query}` : ""}`;
	const lines = [`curl${action.http.method === "GET" ? "" : ` -X ${action.http.method}`} "${url}"`, `  -H "Authorization: Bearer ${apiKey}"`];
	if (!isQuery) {
		const body = getExampleBody(action, example);
		if (Object.keys(body).length > 0) {
			lines.push('  -H "Content-Type: application/json"', `  -d '${JSON.stringify(body).replaceAll("'", "'\\''")}'`);
		}
	}
	return lines.join(" \\\n");
}

// The contacts page's first signup, for one of the account's newsletters, with a key to paste in.
export function getAddContactCurl(appUrl, newsletterSlug) {
	return getCurlExample(getAction("add_contact"), appUrl, {
		apiKey: "YOUR_API_KEY",
		example: newsletterSlug ? { newsletter: newsletterSlug } : {},
	});
}

// What /docs/api, /llms-full.txt and the OpenAPI document say about each endpoint. The registry never changes while the server
// runs, and the list takes some 40 ms to build (every schema becomes a parameter list), which the docs' layout and page each
// asked for on every request: it is built once per address and shared, so callers only read it.
const endpointLists = new Map();

export function getEndpoints(appUrl) {
	let endpoints = endpointLists.get(appUrl);
	if (!endpoints) {
		if (endpointLists.size >= 4) endpointLists.clear();
		endpoints = buildEndpoints(appUrl);
		endpointLists.set(appUrl, endpoints);
	}
	return endpoints;
}

function buildEndpoints(appUrl) {
	return ACTIONS.map((action) => ({
		name: action.name,
		slug: getSlug(action),
		title: action.title,
		description: action.description,
		group: action.group,
		method: action.http.method,
		path: `${API_BASE_PATH}${action.http.path}`,
		level: describeActionAccess(action),
		scopeClass: getActionClass(action.name, {}),
		requiresPlan: action.requiresPlan,
		hints: { readOnly: action.readOnly, destructive: action.destructive, idempotent: action.idempotent, openWorld: action.openWorld },
		parameters: getParameters(action),
		curl: getCurlExample(action, appUrl),
	}));
}

export function getEndpointGroups(appUrl) {
	const endpoints = getEndpoints(appUrl);
	return ACTION_GROUPS.map((group) => ({
		group,
		slug: group.toLowerCase().replaceAll(" ", "-"),
		description: GROUP_DESCRIPTIONS[group] ?? "",
		endpoints: endpoints.filter((endpoint) => endpoint.group === group),
	}));
}
