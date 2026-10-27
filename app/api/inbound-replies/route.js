import { readBoundedText } from "@/lib/request-text";
import * as z from "zod";
import { verifyReplyIngest } from "@/lib/reply-ingest-auth";
import { ingestReply } from "@/lib/replies";
import { connectDb } from "@/lib/db";
const input = z.object({ to: z.string().max(254), from: z.string().max(254), externalId: z.string().min(1).max(500), subject: z.string().max(300), text: z.string().max(30000) });
export async function POST(request) {
	if (!process.env.REPLY_INGEST_SECRET) return new Response(null, { status: 404 });
	let body;
	try { body = await readBoundedText(request, 200000); } catch { return new Response(null, { status: 413 }); }
	if (body.length > 200000) return new Response(null, { status: 413 });
	if (!verifyReplyIngest(request.headers.get("x-flockstack-reply"), body)) return new Response(null, { status: 401 });
	try {
		const parsed = input.parse(JSON.parse(body));
		await connectDb();
		return Response.json(await ingestReply(parsed));
	} catch (error) {
		return Response.json({ error: "Reply not accepted" }, { status: error.code === "rate_limited" ? 429 : error.code === "not_found" ? 404 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503 });
	}
}
