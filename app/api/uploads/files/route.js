import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-image";

// The editor's File block: the file as the body and its name in a header, through the same upload_file action as the
// API. Only the dashboard's own pages upload, as for images (../route.js).
function readFolderHeader(request) {
	try {
		return decodeURIComponent(request.headers.get("x-folder") ?? "").slice(0, 60) || undefined;
	} catch {
		return undefined;
	}
}

export async function POST(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const bytes = Buffer.from(await request.arrayBuffer());
	if (bytes.length > MAX_UPLOAD_BYTES) return Response.json({ error: "Files must be under 4 MB" }, { status: 413 });
	let fileName = "";
	try {
		fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "").slice(0, 120);
	} catch {
		return Response.json({ error: "The file's name can't be read" }, { status: 400 });
	}
	try {
		const file = await runAction("upload_file", { ...current, via: "dashboard", input: { base64: bytes.toString("base64"), fileName, folder: readFolderHeader(request) } });
		return Response.json({ url: file.url, name: file.name, bytes: file.bytes });
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: code === "validation_failed" ? 415 : getErrorStatus(code) });
	}
}
