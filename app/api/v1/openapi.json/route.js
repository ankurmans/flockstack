import { getAppUrl } from "@/lib/config";
import { getOpenApiDocument } from "@/lib/docs/openapi";

export const dynamic = "force-static";

export function GET() {
	return Response.json(getOpenApiDocument(getAppUrl()), { headers: { "access-control-allow-origin": "*" } });
}
