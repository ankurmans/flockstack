import { getContentDisposition } from "@/lib/attachment-files";
import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";

// A visual of a content item as a download, for posting by hand: the media library's file, read from its address and sent on
// with a name and Content-Disposition attachment, because a browser ignores `download` on a link to the CDN's host. Only the
// signed-in account's own items; the address is the one the library recorded.
export async function GET(_request, { params }) {
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const { id, position } = await params;
	try {
		const item = await runAction("get_content_item", { ...current, via: "dashboard", input: { id } });
		const asset = item.assets[Number(position) - 1];
		if (!asset?.url) return Response.json({ error: "Visual not found" }, { status: 404 });
		const file = await fetch(asset.url);
		if (!file.ok || !file.body) return Response.json({ error: "The file isn't available" }, { status: 502 });
		return new Response(file.body, {
			headers: {
				"content-type": asset.contentType ?? "application/octet-stream",
				"content-disposition": getContentDisposition(asset.name ?? `visual-${position}`),
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			},
		});
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
