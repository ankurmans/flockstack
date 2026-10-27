import { connectDb } from "@/lib/db";
import { readBoundedText } from "@/lib/request-text";
import { translateForReader } from "@/lib/reader-translation";
export const dynamic = "force-dynamic";
const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" } });
export async function POST(request) {
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return reply({ error: "forbidden" }, 403);
	try {
		const input = JSON.parse(await readBoundedText(request, 2048));
		if (!input || ![input.slug, input.post, input.language].every((value) => typeof value === "string" && value.length <= 120)) return reply({ error: "invalid_input" }, 400);
		await connectDb();
		const result = await translateForReader(input);
		return reply(result, result.status === "pending" ? 202 : 200);
	} catch (error) {
		if (error instanceof RangeError) return reply({ error: "invalid_input" }, 413);
		if (error instanceof SyntaxError) return reply({ error: "invalid_input" }, 400);
		const code = error.translationCode ?? "unavailable";
		return reply({ error: code }, ({ signin_required: 401, disabled: 403, invalid_language: 400, not_found: 404, rate_limited: 429, daily_limit: 429, too_long: 422, issue_changed: 409 })[code] ?? 503);
	}
}
