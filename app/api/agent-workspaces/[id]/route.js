import { readBoundedText } from "@/lib/request-text";
import { readDraftWorkspace, updateDraftWorkspace } from "@/lib/agent-workspaces";
import { getErrorStatus, toActionError } from "@/lib/actions/errors";
export const dynamic = "force-dynamic";
async function handle(request, context, edit) {
	const { id } = await context.params;
	const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
	try {
		let result;
		if (edit) {
			const raw = await readBoundedText(request, 230000);
			if (Buffer.byteLength(raw) > 230_000) return Response.json({ error: "Workspace is too large" }, { status: 413 });
			const body = JSON.parse(raw);
			result = await updateDraftWorkspace(id, token, body.payload, body.revision);
		} else result = await readDraftWorkspace(id, token);
		return Response.json(result, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof RangeError) return Response.json({ error: "Request too large" }, { status: 413 });
		const failure = error instanceof SyntaxError ? { code: "validation_failed", message: "Send JSON" } : toActionError(error);
		return Response.json({ error: failure }, { status: getErrorStatus(failure.code), headers: { "cache-control": "no-store" } });
	}
}
export const GET = (request, context) => handle(request, context, false);
export const PATCH = (request, context) => handle(request, context, true);
