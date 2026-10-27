import { readBoundedText } from "@/lib/request-text";
import { createWorkspace } from "@/lib/agent-workspaces";
import { getErrorStatus, toActionError } from "@/lib/actions/errors";
export const dynamic = "force-dynamic";
export async function POST(request) {
	if (Number(request.headers.get("content-length") || 0) > 230_000) return Response.json({ error: "Workspace is too large" }, { status: 413 });
	try {
		const text = await readBoundedText(request, 230000);
		if (Buffer.byteLength(text) > 230_000) return Response.json({ error: "Workspace is too large" }, { status: 413 });
		return Response.json(await createWorkspace(JSON.parse(text), request.headers), { status: 201, headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof RangeError) return Response.json({ error: "Request too large" }, { status: 413 });
		const failure = error instanceof SyntaxError ? { code: "validation_failed", message: "Send a JSON brand brief" } : toActionError(error);
		return Response.json({ error: failure }, { status: getErrorStatus(failure.code), headers: { "cache-control": "no-store" } });
	}
}
