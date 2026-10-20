import { EMBED_SCRIPT } from "@/lib/embed-script";

// /embed.js on any host (proxy.js rewrites it here): the same file everywhere, loaded by any site.
export function GET() {
	return new Response(EMBED_SCRIPT, {
		headers: {
			"Content-Type": "text/javascript; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"Access-Control-Allow-Origin": "*",
			"Cross-Origin-Resource-Policy": "cross-origin",
		},
	});
}
