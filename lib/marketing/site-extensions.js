import { SUPPORT_EMAIL } from "@/lib/config";
import { getPublishedLegalPages } from "@/lib/legal";
import { LANDING_PATH, siteRouting } from "@/lib/marketing/site-routing";
import { TAGLINE } from "@/lib/site";

// FlockStack Cloud's marketing site: its landing page renders at "/home" for signed-out visitors at "/" (proxy.js),
// with the share image next to it. The default in lib/site-extensions.js adds nothing.
export { LANDING_PATH };

export const siteExtensions = {
	landingPath: LANDING_PATH,
	get publicPages() {
		return siteRouting.publicPages;
	},
	isPublicPath: (pathname) => siteRouting.isPublicPath(pathname),
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
	// The home page for a visitor, the dashboard once signed in: SupportChat opens on arrival and from links here.
	supportChatPath: "/?support",
	// Loaded when called, like sendGoalOnNextPage.
	supportAssistant: {
		chat: async (request) => (await import("@/lib/marketing/support-assistant")).answerSupportChat(request),
		email: async (request) => (await import("@/lib/marketing/support-assistant")).emailSupportTranscript(request),
	},
	defaultPostalAddress: null,
};
