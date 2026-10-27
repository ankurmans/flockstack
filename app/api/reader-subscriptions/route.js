import { readBoundedText } from "@/lib/request-text";
import { signUp } from "@/lib/signup";
import { getClientIp } from "@/lib/rate-limit";

// Public reader signup: an agent needs the reader's inbox confirmation, never an owner credential.
export async function POST(request) {
	try {
		const text = await readBoundedText(request, 4096);
		if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413 });
		const input = JSON.parse(text);
		if (!input || input.consent !== true || typeof input.email !== "string" || typeof input.newsletter !== "string") return Response.json({ error: "Provide newsletter slug, email and consent: true" }, { status: 400 });
		const formData = new FormData();
		formData.set("email", input.email); formData.set("newsletter", input.newsletter);
		const result = await signUp({ formData, ip: request.headers.get("cf-connecting-ip") ?? getClientIp(request.headers), headers: request.headers, source: "reader_api", forceConfirmation: true, resubscribe: false });
		if (result.error) return Response.json({ error: result.error }, { status: 400 });
		// Do not reveal whether this address is already subscribed, suppressed or awaiting confirmation.
		return Response.json({ accepted: true, message: "Check your inbox if confirmation is needed. Existing subscription preferences are preserved." }, { status: 202, headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof RangeError) return Response.json({ error: "Request too large" }, { status: 413 });
		if (error instanceof SyntaxError) return Response.json({ error: "Use a JSON object" }, { status: 400 });
		return Response.json({ error: "Signup unavailable" }, { status: 503 });
	}
}
