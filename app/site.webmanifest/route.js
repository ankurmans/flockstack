import { APP_NAME } from "@/lib/config";

export const dynamic = "force-static";

// The public pages link it (app/(site)/layout.js). It isn't app/manifest.js, which every page would link, a
// newsletter's archive included. The icons are app/apple-icon.png's plane on white at 192 and 512 pixels; none is
// maskable, since the plane's tip reaches past the circle a launcher may cut a maskable icon to.
export function GET() {
	return Response.json(
		{
			id: "/",
			name: APP_NAME,
			short_name: APP_NAME,
			start_url: "/",
			display: "standalone",
			background_color: "#ffffff",
			theme_color: "#ffffff",
			icons: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
			],
		},
		{ headers: { "content-type": "application/manifest+json" } }
	);
}
