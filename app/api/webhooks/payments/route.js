import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { getPaymentsMode, getPaymentsWebhookSecret } from "@/lib/payments/config";
import { handlePaymentEvent } from "@/lib/payments/events";
import { verifyStripeSignature } from "@/lib/payments/signature";

function reply(status, body) {
	return NextResponse.json(body, { status });
}

// What creators earn: Stripe Checkout payments, refunds, subscriptions and Connect account updates. Apart from
// /api/webhooks/stripe, which is FlockStack's own plan billing, and signed with its own secret. On FlockStack Cloud this
// endpoint listens to events on connected accounts. Stripe sends an event until it gets a 2xx, and every handler is safe
// to run again.
export async function POST(request) {
	if (getPaymentsMode() === "none") return reply(404, { error: "Payments are off on this server" });
	const secret = getPaymentsWebhookSecret();
	if (!secret) return reply(503, { error: "Payment webhooks are not configured" });

	const body = await request.text();
	if (!(await verifyStripeSignature({ body, header: request.headers.get("stripe-signature"), secret }))) {
		return reply(400, { error: "Invalid signature" });
	}

	let event;
	try {
		event = JSON.parse(body);
	} catch {
		return reply(400, { error: "Invalid payload" });
	}
	if (typeof event?.id !== "string" || typeof event.type !== "string" || !event.data?.object) return reply(400, { error: "Invalid payload" });

	try {
		return reply(200, { received: true, ...(await handlePaymentEvent(event)) });
	} catch (error) {
		console.error(`[payments-webhook] ${event.type} ${event.id} failed:`, error);
		await sendAlert({
			accountId: null,
			key: `payments-webhook-failed:${event.type}`,
			title: "Payment event not handled",
			detail: `${event.type} ${event.id}: ${String(error?.message ?? error).slice(0, 300)}.`,
			action: "Stripe sends it again for 3 days; until then a sale or a paid subscription can be missing. Check the logs.",
			link: "https://dashboard.stripe.com/webhooks",
		});
		return reply(500, { error: "Could not handle the event" });
	}
}
