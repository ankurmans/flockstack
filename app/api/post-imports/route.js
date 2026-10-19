import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/post-import-report";

// Sent percent-encoded, as headers carry no other characters.
function readHeader(request, name, max) {
	try {
		return decodeURIComponent(request.headers.get(name) ?? "").slice(0, max) || undefined;
	} catch {
		return undefined;
	}
}

// The import page's upload: the export as the body, through the same create_post_import action as the API, without the
// base64 the API needs. Archives on <slug>.<shared domain> can share the dashboard's origin, so only same-origin
// requests upload.
export async function POST(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const declared = Number(request.headers.get("content-length"));
	const tooLarge = `Exports must be under ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB`;
	if (declared > MAX_IMPORT_FILE_BYTES) return Response.json({ error: tooLarge }, { status: 413 });
	const file = new Uint8Array(await request.arrayBuffer());
	if (file.length > MAX_IMPORT_FILE_BYTES) return Response.json({ error: tooLarge }, { status: 413 });
	try {
		const postImport = await runAction("create_post_import", {
			...current,
			via: "dashboard",
			input: {
				file,
				newsletter: readHeader(request, "x-newsletter", 100),
				fileName: readHeader(request, "x-file-name", 200),
				siteUrl: readHeader(request, "x-site-url", 300),
			},
		});
		return Response.json({ import: postImport });
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
