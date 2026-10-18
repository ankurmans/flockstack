import { SUPPORT_EMAIL } from "@/lib/config";
import { LEGAL_PAGES, LEGAL_PATHS } from "@/lib/legal";
import { TAGLINE } from "@/lib/site";

// FlockStack Cloud's marketing site: its landing page renders at "/home" for signed-out visitors at "/" (proxy.js),
// with the share image next to it. The default in lib/site-extensions.js adds nothing.
export const LANDING_PATH = "/home";

export const siteExtensions = {
	landingPath: LANDING_PATH,
	// The legal pages (app/(site)/terms and the others) are about FlockStack Cloud, so a self-hosted server answers 404 for them.
	publicPages: ["/", ...LEGAL_PATHS],
	isPublicPath: (pathname) => /^\/home\/opengraph-image(-\w+)?$/.test(pathname),
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
		legal: LEGAL_PAGES.map(({ href, label }) => ({ href, label })),
	},
	twitterCreator: null,
	sendGoalOnNextPage: async () => {},
	readCheckoutAttribution: async () => ({}),
	supportChatPath: null,
	defaultPostalAddress: null,
};
