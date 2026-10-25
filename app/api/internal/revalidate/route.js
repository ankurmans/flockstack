import { revalidatePath } from "next/cache";
import { getAppSecrets } from "@/lib/config";
import { readRevalidateBody, SIGNATURE_HEADER, verifySignature } from "@/lib/internal-revalidate";

export const dynamic = "force-dynamic";

// The lean API Worker (workers/api) has no Next.js, so an action that drops a cached page there asks the app to: this is where
// the request lands. The signature (lib/internal-revalidate.js) is the only credential, and the pages it may name are a short list.
export async function POST(request) {
	const body = await request.text();
	if (!getAppSecrets().some((secret) => verifySignature(body, request.headers.get(SIGNATURE_HEADER), secret))) return Response.json({ error: "unauthorized" }, { status: 401 });
	const entries = readRevalidateBody(body);
	if (!entries) return Response.json({ error: "invalid" }, { status: 400 });
	for (const [path, type] of entries) revalidatePath(path, type);
	return Response.json({ revalidated: entries.length });
}
