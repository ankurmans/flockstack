import { APP_NAME } from "@/lib/config";

export const dynamic = "force-static";

// The public pages link it (app/(site)/layout.js). It isn't app/manifest.js, which every page would link, a
// newsletter's archive included. The icons are the ink tile of app/icon.svg at 192 and 512 pixels; none is maskable,
// since the wings reach past the circle a launcher may cut a maskable icon to.
export function GET() {
	return Response.json(
		{
			id: "/",
			name: APP_NAME,
			short_name: APP_NAME,
			start_url: "/",
			display: "standalone",
			background_color: "#0b0b0b",
			theme_color: "#0b0b0b",
			icons: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
			],
		},
		{ headers: { "content-type": "application/manifest+json" } }
	);
}
