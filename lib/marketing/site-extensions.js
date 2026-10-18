import { SUPPORT_EMAIL } from "@/lib/config";
import { TAGLINE } from "@/lib/site";

// FlockStack Cloud's marketing site: its landing page renders at "/home" for signed-out visitors at "/" (proxy.js),
// with the share image next to it. The default in lib/site-extensions.js adds nothing.
export const LANDING_PATH = "/home";

export const siteExtensions = {
	landingPath: LANDING_PATH,
	publicPages: ["/"],
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
	},
	twitterCreator: null,
	sendGoalOnNextPage: async () => {},
	readCheckoutAttribution: async () => ({}),
	supportChatPath: null,
	defaultPostalAddress: null,
};
