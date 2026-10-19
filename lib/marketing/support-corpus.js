import "server-only";
import DocsPage from "@/app/(site)/docs/page";
import AudiencesPage from "@/app/(site)/docs/audiences/page";
import AuthenticationPage from "@/app/(site)/docs/authentication/page";
import CommentsPage from "@/app/(site)/docs/comments/page";
import ErrorsPage from "@/app/(site)/docs/errors/page";
import ExportPage from "@/app/(site)/docs/export/page";
import McpPage from "@/app/(site)/docs/mcp/page";
import RecommendationsPage from "@/app/(site)/docs/recommendations/page";
import ReferralsPage from "@/app/(site)/docs/referrals/page";
import RegionsPage from "@/app/(site)/docs/regions/page";
import RssPage from "@/app/(site)/docs/rss/page";
import SellingPage from "@/app/(site)/docs/selling/page";
import WarningsPage from "@/app/(site)/docs/warnings/page";
import PrivacyPage from "@/app/(site)/privacy/page";
import SubProcessorsPage from "@/app/(site)/sub-processors/page";
import TermsPage from "@/app/(site)/terms/page";
import { isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/llms";
import { getEndpointGroups } from "@/lib/docs/reference";
import { formatNumber } from "@/lib/format";
import { getPublishedLegalPages, isLegalPublished } from "@/lib/legal";
import { FAQ, PRICE_PROMISE, getMaxSavingPercent } from "@/lib/marketing/landing";
import { cleanText, readPageSections } from "@/lib/marketing/support-page-text";
import { buildIndex } from "@/lib/marketing/support-search";
import { DEDICATED_IP_PLAN_IDS, EXTRA_EMAILS, PLANS, YEARLY_MONTHS, getDedicatedIpPrice, getPlan } from "@/lib/plans";

// What the support assistant answers from: the same sources as /docs, /llms-full.txt and the legal pages, read when the
// first question comes and kept for the isolate's life. Every chunk is one heading's section with the page link it
// came from. The API reference is one chunk per endpoint, from the same schemas the docs render.
const DOC_COMPONENTS = {
	"/docs": DocsPage,
	"/docs/authentication": AuthenticationPage,
	"/docs/audiences": AudiencesPage,
	"/docs/warnings": WarningsPage,
	"/docs/errors": ErrorsPage,
	"/docs/mcp": McpPage,
	"/docs/rss": RssPage,
	"/docs/export": ExportPage,
	"/docs/referrals": ReferralsPage,
	"/docs/recommendations": RecommendationsPage,
	"/docs/comments": CommentsPage,
	"/docs/selling": SellingPage,
	"/docs/regions": RegionsPage,
};
const LEGAL_COMPONENTS = { "/terms": TermsPage, "/privacy": PrivacyPage, "/sub-processors": SubProcessorsPage };
const API_PATH = "/docs/api";

// About 300 tokens: a few of them fit the prompt with room for the conversation.
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 40;
const API_WEIGHT = 0.75;

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
		add({ title: "Pricing: FlockStack Cloud plans", href: "/#pricing", text: getPricingText() });
		for (const { question, answer } of FAQ) add({ title: `FAQ: ${question}`, href: "/#faq", text: answer.join("\n") });
	}
	return chunks.map((chunk, index) => ({ id: index + 1, ...chunk }));
}

// lib/plans.js, as the pricing section and the billing page show it.
export function getPricingText() {
	return [
		`How much each FlockStack Cloud plan costs, in US dollars. Each plan is a number of emails a month and of subscribers. Yearly plans cost ${YEARLY_MONTHS} months instead of 12.`,
		...PLANS.map(
			({ name, monthlyPrice, emailsPerMonth, subscribers }) =>
				`- ${name}: $${monthlyPrice} a month or $${formatNumber(monthlyPrice * YEARLY_MONTHS)} a year, ${formatNumber(emailsPerMonth)} emails a month, up to ${formatNumber(subscribers)} subscribers.`
		),
		`Extra emails: past a paid plan's emails, sending goes on at $${EXTRA_EMAILS.pricePerThousand} per 1,000 extra emails, billed with the plan at the end of the period, up to a monthly limit the owner sets on the billing page (the plan's own emails by default, 10 times them at most). The owner is emailed at 80% and 100% of the limit. Free plans from FlockStack stop at their emails.`,
		`Dedicated IP add-on, on Pro, Scale and Max: ${DEDICATED_IP_PLAN_IDS.map((id) => `$${getDedicatedIpPrice(id, "month")} a month on ${getPlan(id).name}`).join(", ")}; yearly costs ${YEARLY_MONTHS} months. Your own sending IP, warmed up automatically, best for steady volume above 250,000 emails a month. Bought on the billing page; it turns on once paid.`,
		`Sending more than ${formatNumber(PLANS.at(-1).emailsPerMonth)} emails a month: ask support.`,
		`(price comparison removed)`,
		"Our price promise:",
		...PRICE_PROMISE.map(({ title, text }) => `- ${title}: ${text}`),
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
	if (piece) pieces.push(piece);
	return pieces.map((part) => ({ title, href, text: part, ...extra }));
}
