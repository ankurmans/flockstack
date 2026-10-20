import { getAppUrl } from "@/lib/config";
import { getLlmsIndex } from "@/lib/docs/llms";

export const dynamic = "force-dynamic";

// The docs part of /llms.txt, which the website serves merged with its own (docs/ROUTING.md of the website repository).
export function GET() {
	return new Response(getLlmsIndex(getAppUrl(), { docsOnly: true }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
