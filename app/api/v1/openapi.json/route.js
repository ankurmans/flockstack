import { getAppUrl } from "@/lib/config";
import { getOpenApiDocument } from "@/lib/docs/openapi";

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(getOpenApiDocument(getAppUrl()), { headers: { "access-control-allow-origin": "*" } });
}
