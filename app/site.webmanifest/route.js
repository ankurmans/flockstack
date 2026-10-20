import { APP_NAME } from "@/lib/config";
import { WEB_APP_ICONS, WEB_APP_SHORTCUTS } from "@/lib/web-app";

export const dynamic = "force-static";

// The public pages (app/(site)/layout.js) and the dashboard (app/(app)/layout.js, app/(account)/layout.js) link it, so the
// dashboard installs as an app (lib/web-app.js). It isn't app/manifest.js, which every page would link, a newsletter's
// archive included. The icons are the ink tile of app/icon.svg at 192 and 512 pixels; none is maskable,
// since the wings reach past the circle a launcher may cut a maskable icon to.
export function GET() {
	return Response.json(
		{
			id: "/",
			name: APP_NAME,
			short_name: APP_NAME,
			description: "Write, send and grow your newsletter.",
			start_url: "/",
			scope: "/",
			display: "standalone",
			background_color: "#0b0b0b",
			theme_color: "#0b0b0b",
			icons: WEB_APP_ICONS,
			shortcuts: WEB_APP_SHORTCUTS.map((shortcut) => ({ ...shortcut, icons: WEB_APP_ICONS.slice(0, 1) })),
		},
		{ headers: { "content-type": "application/manifest+json" } }
	);
}
