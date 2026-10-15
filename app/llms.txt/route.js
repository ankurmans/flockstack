import { getAppUrl } from "@/lib/config";
import { getLlmsIndex } from "@/lib/docs/llms";

export const dynamic = "force-static";

export function GET() {
	return new Response(getLlmsIndex(getAppUrl()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
