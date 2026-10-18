import { SUPPORT_EMAIL } from "@/lib/config";
import { LEGAL_PATHS, getPublishedLegalPages } from "@/lib/legal";
import { TAGLINE } from "@/lib/site";

// FlockStack Cloud's marketing site: its landing page renders at "/home" for signed-out visitors at "/" (proxy.js),
// with the share image next to it. The default in lib/site-extensions.js adds nothing.
export const LANDING_PATH = "/home";

export const siteExtensions = {
	landingPath: LANDING_PATH,
	// The legal pages (app/(site)/terms and the others) are about FlockStack Cloud, so a self-hosted server answers 404 for them.
	// Read when asked: they are listed only once lib/legal.js has no placeholder left.
	get publicPages() {
		return ["/", ...getPublishedLegalPages().map(({ href }) => href)];
	},
	// The support assistant answers signed-out visitors too, on the home page, docs, legal pages and sign-in. The legal
	// pages open while hidden too, so a visitor gets their 404 rather than the sign-in page.
	isPublicPath: (pathname) => /^\/home\/opengraph-image(-\w+)?$/.test(pathname) || pathname === "/api/support/chat" || LEGAL_PATHS.includes(pathname),
	headerLinks: [{ href: "/#pricing", label: "Pricing" }],
	headerAction: { href: "/signin", label: "Get started" },
	footer: {
		tagline: `${TAGLINE}.`,
		columns: [
			{
				title: "Product",
				links: [
					{ href: "/#features", label: "Features" },
					{ href: "/#pricing", label: "Pricing" },
					{ href: "/#faq", label: "FAQ" },
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
	// The home page for a visitor, the dashboard once signed in: SupportChat opens on arrival and from links here.
	supportChatPath: "/?support",
	// Loaded when called, like sendGoalOnNextPage.
	supportAssistant: {
		chat: async (request) => (await import("@/lib/marketing/support-assistant")).answerSupportChat(request),
		email: async (request) => (await import("@/lib/marketing/support-assistant")).emailSupportTranscript(request),
	},
	defaultPostalAddress: null,
};
