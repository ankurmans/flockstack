import { getAppUrl } from "@/lib/config";
import { getLlmsFull } from "@/lib/docs/llms";

export const dynamic = "force-static";

export function GET() {
	return new Response(getLlmsFull(getAppUrl()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
