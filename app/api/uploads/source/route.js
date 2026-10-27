import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getCurrentAccount } from "@/lib/auth";

// The editor's crop reads the pixels of one of the account's own pictures. The image host may not allow that to a page on
// another origin, so the bytes come through here, from the read_image_source action, which only reads an address the account
// uploaded. Only the dashboard's own pages ask.
export async function GET(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403 });
	const current = await getCurrentAccount();
	if (!current) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const url = new URL(request.url).searchParams.get("url")?.slice(0, 2000) ?? "";
	try {
		const { contentType, base64 } = await runAction("read_image_source", { ...current, via: "dashboard", input: { url } });
		return new Response(Buffer.from(base64, "base64"), {
			headers: { "content-type": contentType, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" },
		});
	} catch (error) {
		const { code, message } = toActionError(error);
		return Response.json({ error: message, code }, { status: getErrorStatus(code) });
	}
}
