import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { handlePolarEvent } from "@/lib/billing-polar";
import { isCloud } from "@/lib/config";
import { isPolarConfigured } from "@/lib/polar";
import { verifyPolarWebhook } from "@/lib/polar-webhook";

function reply(status, body) {
	return NextResponse.json(body, { status });
}

// Polar signs every event with the endpoint's secret. A 5xx makes Polar retry (10 times, then it turns the endpoint off);
// every handler is safe to run again.
export async function POST(request) {
	if (!isCloud()) return reply(404, { error: "Billing is off on this server" });
	const secret = process.env.POLAR_WEBHOOK_SECRET;
	if (!secret || !isPolarConfigured()) return reply(503, { error: "Polar webhooks are not configured" });

	const body = await request.text();
	if (!(await verifyPolarWebhook({ body, headers: request.headers, secret }))) return reply(403, { error: "Invalid signature" });

	let event;
	try {
		event = JSON.parse(body);
	} catch {
		return reply(400, { error: "Invalid payload" });
	}
	const id = request.headers.get("webhook-id");

	try {
		return reply(200, { received: true, ...(await handlePolarEvent(event)) });
	} catch (error) {
		console.error(`[polar-webhook] ${event.type} ${id} failed:`, error);
		await sendAlert({
			accountId: null,
			key: `polar-webhook-failed:${event.type}`,
			title: "Polar event not handled",
			detail: `${event.type} ${id}: ${String(error?.message ?? error).slice(0, 300)}.`,
			action: "Polar retries it 10 times, then turns the endpoint off; until then an account's plan can be out of date. Check the logs.",
			link: "https://polar.sh/dashboard",
		});
		return reply(500, { error: "Could not handle the event" });
	}
}
