import { SUPPORT_EMAIL } from "@/lib/config";
import { getPublishedLegalPages } from "@/lib/legal";
import { siteRouting } from "@/lib/marketing/site-routing";
import { getRegionUrls, isEu } from "@/lib/region";
import { TAGLINE } from "@/lib/site";

// What FlockStack Cloud adds to the pages every server shares: analytics, the help chat, the header and footer links to
// the marketing website (a separate Worker the app forwards its paths to, worker-entry.mjs) and the canonical address.
// The default in lib/site-extensions.js adds nothing.
export const siteExtensions = {
	get publicPages() {
		return siteRouting.publicPages;
	},
	isPublicPath: (pathname) => siteRouting.isPublicPath(pathname),
	// Every region's Worker serves the same docs and legal pages; the US address is the one search engines index.
	getCanonicalOrigin: () => (isEu() ? getRegionUrls().us : null),
	// Paths of the marketing website, not of the app: "/pricing" is forwarded to it (worker-entry.mjs).
	headerLinks: [{ href: "/pricing", label: "Pricing" }],
	headerAction: { href: "/signin", label: "Get started" },
	footer: {
		tagline: `${TAGLINE}.`,
		columns: [
			{
				title: "Product",
				links: [
					{ href: "/pricing", label: "Pricing" },
					{ href: "/compare", label: "Compare" },
					{ href: "/blog", label: "Blog" },
					{ href: "/changelog", label: "Changelog" },
				],
			},
			{
				title: "Developers",
				links: [
					{ href: "/docs", label: "Docs" },
					{ href: "/docs/api", label: "API reference" },
					{ href: "/docs/mcp", label: "MCP server" },
				],
			},
			{
				title: "Support",
				links: [
					{ href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL, isExternal: true },
					{ href: "/signin", label: "Sign in" },
				],
			},
		],
		company: null,
		get legal() {
			return getPublishedLegalPages().map(({ href, label }) => ({ href, label }));
		},
	},
	twitterCreator: null,
	// A cookie with the step's name for the browser's analytics to report on its next page, only for a visitor whose analytics
	// is on (lib/marketing/analytics-request.js). Loaded when called: the proxy imports this module too.
	sendGoalOnNextPage: async (goal) => {
		const { setGoalCookie } = await import("@/lib/marketing/analytics-request");
		await setGoalCookie(goal);
	},
	readCheckoutAttribution: async () => ({}),
	// The dashboard once signed in, where SupportChat opens on arrival; a visitor lands on the website's home page, without a chat.
	supportChatPath: "/?support",
	// Loaded when called, like sendGoalOnNextPage.
	supportAssistant: {
		chat: async (request) => (await import("@/lib/marketing/support-assistant")).answerSupportChat(request),
		email: async (request) => (await import("@/lib/marketing/support-assistant")).emailSupportTranscript(request),
	},
	defaultPostalAddress: null,
};
