import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";
import { MAX_PRODUCT_FILE_BYTES } from "@/lib/products";

// Sent percent-encoded, as headers carry no other characters.
function readFileName(value) {
	try {
		return decodeURIComponent(value ?? "").slice(0, 200) || "download";
	} catch {
		return "download";
	}
}

// The product form's file upload: the file as the body, through the same set_product_file action as the API.
// Archives on <slug>.<shared domain> can share the dashboard's origin, so only same-origin requests upload.
export async function POST(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const bytes = Buffer.from(await request.arrayBuffer());
	if (bytes.length > MAX_PRODUCT_FILE_BYTES) return Response.json({ error: `Files must be under ${MAX_PRODUCT_FILE_BYTES / 1024 / 1024} MB` }, { status: 413 });
	try {
		const product = await runAction("set_product_file", {
			...current,
			via: "dashboard",
			input: {
				id: request.headers.get("x-product-id") ?? "",
				base64: bytes.toString("base64"),
				fileName: readFileName(request.headers.get("x-file-name")),
				contentType: request.headers.get("content-type")?.slice(0, 100),
			},
		});
		return Response.json({ product });
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
