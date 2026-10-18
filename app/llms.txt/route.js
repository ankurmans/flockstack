import { getAppUrl } from "@/lib/config";
import { getLlmsIndex } from "@/lib/docs/llms";

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export function GET() {
	return new Response(getLlmsIndex(getAppUrl()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
