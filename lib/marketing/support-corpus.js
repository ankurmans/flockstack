import "server-only";
import DocsPage from "@/app/(site)/docs/page";
import AgentSafetyPage from "@/app/(site)/docs/agent-safety/page";
import AudiencesPage from "@/app/(site)/docs/audiences/page";
import AudioPage from "@/app/(site)/docs/audio/page";
import AuthenticationPage from "@/app/(site)/docs/authentication/page";
import ContentCalendarPage from "@/app/(site)/docs/content-calendar/page";
import CommentsPage from "@/app/(site)/docs/comments/page";
import ErrorsPage from "@/app/(site)/docs/errors/page";
import ExportPage from "@/app/(site)/docs/export/page";
import FormsPage from "@/app/(site)/docs/forms/page";
import McpPage from "@/app/(site)/docs/mcp/page";
import MovingPage from "@/app/(site)/docs/moving/page";
import RecommendationsPage from "@/app/(site)/docs/recommendations/page";
import ReferralsPage from "@/app/(site)/docs/referrals/page";
import RegionsPage from "@/app/(site)/docs/regions/page";
import ReportsPage from "@/app/(site)/docs/reports/page";
import RssPage from "@/app/(site)/docs/rss/page";
import SellingPage from "@/app/(site)/docs/selling/page";
import WarningsPage from "@/app/(site)/docs/warnings/page";
import WebhooksPage from "@/app/(site)/docs/webhooks/page";
import ZapierMakePage from "@/app/(site)/docs/zapier-make/page";
import PrivacyPage from "@/app/(site)/privacy/page";
import SubProcessorsPage from "@/app/(site)/sub-processors/page";
import TermsPage from "@/app/(site)/terms/page";
import { isCloud } from "@/lib/config";
import { CUSTOM_PATH } from "@/lib/custom-choices";
import { CUSTOM_NOT_YET, getCustomPlan } from "@/lib/custom-tier";
import { DOC_PAGES } from "@/lib/docs/pages";
import { getEndpointGroups } from "@/lib/docs/reference";
import { formatNumber } from "@/lib/format";
import { getPublishedLegalPages, isLegalPublished } from "@/lib/legal";
import { cleanText, readPageSections } from "@/lib/marketing/support-page-text";
import { buildIndex } from "@/lib/marketing/support-search";
import { DEDICATED_IP_AT_COST, DEDICATED_IP_DETAILS, EXTRA_EMAILS, FREE_GUARDS, FREE_PLAN, PLANS, YEARLY_MONTHS } from "@/lib/plans";
import { FAQ, PRICE_PROMISE } from "@/lib/site-faq";

// What the support assistant answers from: the same sources as /docs, /llms-full.txt and the legal pages, read when the
// first question comes and kept for the isolate's life. Every chunk is one heading's section with the page link it
// came from. The API reference is one chunk per endpoint, from the same schemas the docs render.
const DOC_COMPONENTS = {
	"/docs": DocsPage,
	"/docs/authentication": AuthenticationPage,
	"/docs/agent-safety": AgentSafetyPage,
	"/docs/audiences": AudiencesPage,
	"/docs/content-calendar": ContentCalendarPage,
	"/docs/warnings": WarningsPage,
	"/docs/errors": ErrorsPage,
	"/docs/mcp": McpPage,
	"/docs/webhooks": WebhooksPage,
	"/docs/zapier-make": ZapierMakePage,
	"/docs/rss": RssPage,
	"/docs/export": ExportPage,
	"/docs/moving": MovingPage,
	"/docs/referrals": ReferralsPage,
	"/docs/recommendations": RecommendationsPage,
	"/docs/forms": FormsPage,
	"/docs/reports": ReportsPage,
	"/docs/comments": CommentsPage,
	"/docs/audio": AudioPage,
	"/docs/selling": SellingPage,
	"/docs/regions": RegionsPage,
};
const LEGAL_COMPONENTS = { "/terms": TermsPage, "/privacy": PrivacyPage, "/sub-processors": SubProcessorsPage };
const API_PATH = "/docs/api";

// About 300 tokens: a few of them fit the prompt with room for the conversation.
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 40;
const API_WEIGHT = 0.7;

let cache = null;

export async function getSupportIndex(appUrl) {
	const key = `${appUrl}|${isCloud()}|${isLegalPublished()}`;
	if (cache?.key !== key) cache = { key, index: buildChunks(appUrl).then(buildIndex) };
	try {
		return await cache.index;
	} catch (error) {
		cache = null;
		throw error;
	}
}

export async function buildChunks(appUrl) {
	const chunks = [];
	const add = (chunk) => chunks.push(...splitChunk(chunk));
	// Never a legal page that still prints a placeholder: the assistant would quote it.
	const pages = [...DOC_PAGES.filter(({ href }) => href !== API_PATH), ...(isCloud() ? getPublishedLegalPages() : [])];
	for (const { href, title } of pages) {
		const Page = DOC_COMPONENTS[href] ?? LEGAL_COMPONENTS[href];
		if (!Page) continue;
		const sections = await readPageSections(await Page({}));
		for (const { heading, anchor, text } of sections) {
			// A kicker above the title ("Guides") or an empty heading says nothing to search.
			if (text.length < MIN_CHUNK_CHARS) continue;
			const isPageTitle = !heading || heading === title;
			add({ title: isPageTitle ? title : `${title}: ${heading}`, href: anchor ? `${href}#${anchor}` : href, text });
		}
	}
	for (const { group, endpoints } of getEndpointGroups(appUrl)) {
		for (const { name, title, method, path, description, parameters } of endpoints) {
			const params = parameters.map(({ name: param, type, required, description: about }) => `- ${param} (${type}${required ? ", required" : ""})${about ? `: ${about}` : ""}`);
			add({
				// A person asking support wants the guide first; the endpoint answers the same words for code.
				weight: API_WEIGHT,
				title: `API reference: ${title}`,
				href: `${API_PATH}#${name.replaceAll("_", "-")}`,
				text: [`${group}. ${method} ${path}, MCP tool ${name}.`, description, ...params].join("\n"),
			});
		}
	}
	if (isCloud()) {
		add({ title: "Pricing: FlockStack Cloud plans", href: "/pricing", text: getPricingText() });
		add({ title: "Custom plan", href: CUSTOM_PATH, text: getCustomPlanText() });
		for (const { question, answer } of FAQ) add({ title: `FAQ: ${question}`, href: "/#faq", text: answer.join("\n") });
	}
	return chunks.map((chunk, index) => ({ id: index + 1, ...chunk }));
}

// lib/plans.js, as the pricing page and the billing page show it.
export function getPricingText() {
	return [
		`How much each FlockStack Cloud plan costs, in US dollars. Each plan is a number of emails a month and of subscribers. Yearly plans cost ${YEARLY_MONTHS} months instead of 12.`,
		`- Free: $0, no card, ${formatNumber(FREE_PLAN.emailsPerMonth)} emails a month, up to ${formatNumber(FREE_PLAN.subscribers)} subscribers, ${FREE_PLAN.newsletters} newsletter, ${FREE_PLAN.automations} automations besides the welcome email, ${FREE_PLAN.webhookEndpoints} webhook endpoint. Every account starts on it. It has your own domain, polls, surveys, forms, the API and MCP, and a small "Sent with FlockStack" link on its emails and website, which paid plans remove. It never goes past its limits and is never billed: a send that wouldn't fit is refused up front, with the numbers. Your first ${FREE_GUARDS.firstCampaigns.count} campaigns go to ${formatNumber(FREE_GUARDS.firstCampaigns.recipients)} people at most while FlockStack gets to know your sending. If a paid plan ends, the account goes back to Free and keeps everything; if it is over Free's limits, campaigns wait until it is under them or it upgrades.`,
		...PLANS.map(
			({ name, monthlyPrice, emailsPerMonth, subscribers }) =>
				`- ${name}: $${monthlyPrice} a month or $${formatNumber(monthlyPrice * YEARLY_MONTHS)} a year, ${formatNumber(emailsPerMonth)} emails a month, up to ${formatNumber(subscribers)} subscribers.`
		),
		`Extra emails: past a paid plan's emails, sending goes on at $${EXTRA_EMAILS.pricePerThousand} per 1,000 extra emails, billed with the plan at the end of the period, up to a monthly limit the owner sets on the billing page (the plan's own emails by default, 10 times them at most). The owner is emailed at 80% and 100% of the limit. The Free plan and plans from FlockStack stop at their emails.`,
		`Dedicated IP add-on, on Pro, Scale and Max: ${DEDICATED_IP_AT_COST} It is billed monthly, even next to a yearly plan, and costs the same on all three plans. ${DEDICATED_IP_DETAILS} Bought on the billing page. If no IP is free it is set up within 2 business days; until the warm-up finishes (a growing share of your email goes through the IP each day, held on a day with many bounces or complaints) the rest goes through shared IPs. It ends when you cancel it or your plan drops below Pro.`,
		`Past ${PLANS.at(-1).name} (over ${formatNumber(PLANS.at(-1).subscribers)} subscribers or ${formatNumber(PLANS.at(-1).emailsPerMonth)} emails a month): the Custom plan, "${getCustomPlan().price}". See the Custom plan page, ${CUSTOM_PATH}.`,
		"Our price promise:",
		...PRICE_PROMISE.map(({ title, text }) => `- ${title}: ${text}`),
	].join("\n");
}

// The Custom plan (lib/custom-tier.js): what it has today and what FlockStack doesn't have yet, so the assistant never says more.
export function getCustomPlanText() {
	const plan = getCustomPlan();
	return [
		`Custom plan, for lists with ${plan.subscribers.toLowerCase()} subscribers or ${plan.emails.toLowerCase()} emails a month. It has no price list: its price is "${plan.price}". Someone from FlockStack replies personally. ${plan.reply}`,
		`A Custom plan has: ${plan.bullets.join("; ")}.`,
		`To ask for one, use the form at ${CUSTOM_PATH} (button "${plan.button}"): it asks what the list sends and which extras would be needed.`,
		CUSTOM_NOT_YET,
		"FlockStack has none of those today, so never say it does.",
	].join("\n");
}

// A long section becomes several chunks at its paragraph or list breaks, each with the section's title and link.
function splitChunk({ title, href, text, weight }) {
	const clean = cleanText(text);
	const extra = weight ? { weight } : {};
	if (clean.length <= MAX_CHUNK_CHARS) return [{ title, href, text: clean, ...extra }];
	const pieces = [];
	let piece = "";
	for (const part of clean.split(/\n/)) {
		if (piece && piece.length + part.length + 1 > MAX_CHUNK_CHARS) {
			pieces.push(piece);
			piece = "";
		}
		piece = piece ? `${piece}\n${part}` : part.slice(0, MAX_CHUNK_CHARS * 2);
	}
	// A last line too short to stand as a chunk rejoins the one before it.
	if (piece.length < MIN_CHUNK_CHARS && pieces.length > 0) pieces[pieces.length - 1] += `\n${piece}`;
	else if (piece) pieces.push(piece);
	return pieces.map((part) => ({ title, href, text: part, ...extra }));
}
