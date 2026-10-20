import { APP_NAME } from "./config.js";

// The dashboard installs as an app: a manifest (app/site.webmanifest/route.js), its icons and, for Safari, the page's own
// metadata. There is no service worker and nothing cached: an installed FlockStack opens the live dashboard and needs the
// network, like the tab does.
export const WEB_APP_METADATA = {
	manifest: "/site.webmanifest",
	appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
};

export const WEB_APP_ICONS = [
	{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
	{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
];

// A few pages the installed app offers from its icon.
export const WEB_APP_SHORTCUTS = [
	{ name: "Campaigns", url: "/campaigns" },
	{ name: "Contacts", url: "/contacts" },
];
