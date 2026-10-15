import { NextResponse } from "next/server";
import { sendAlertIfRepeated } from "@/lib/alerts";
import { isValidSubscribeUrl, verifySnsMessage } from "@/lib/sns";
import { isPlainObject } from "@/lib/validation";

// SNS messages are at most 256 KB; the envelope adds a little.
const MAX_BODY_LENGTH = 512 * 1024;

function reply(status, body) {
	return NextResponse.json(body, { status });
}

function parseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

async function confirmSubscription(message, label) {
	if (!isValidSubscribeUrl(message.SubscribeURL)) return reply(400, { error: "Invalid SubscribeURL" });
	const response = await fetch(message.SubscribeURL, {
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null);
	if (!response?.ok) return reply(502, { error: "Subscription confirmation failed" });

	console.log(`[${label}] Confirmed the subscription to ${message.TopicArn}`);
	return reply(200, { ok: true });
}

async function handleNotification(message, { label, handle }) {
	const event = parseJson(message.Message);
	if (!isPlainObject(event)) return reply(200, { ok: true, ignored: true });

	try {
		const { handled } = await handle(event);
		return reply(200, { ok: true, ...(!handled && { ignored: true }) });
	} catch (error) {
		// A 5xx makes SNS retry; handlers are safe to replay.
		console.error(`[${label}] Could not handle the event:`, error);
		await sendAlertIfRepeated(label, {
			accountId: null,
			key: `webhook-failing:${label}`,
			title: "Webhook failing",
			detail: `${label} couldn't handle 3 events within an hour: ${String(error?.message ?? error).slice(0, 300)}.`,
			action: "SNS retries each one for a while, then drops it: check the logs.",
		});
		return reply(500, { error: "Could not handle the event" });
	}
}

// One SNS topic per route. Needs an HTTPS subscription with raw message delivery off, so the envelope is signed.
export async function handleSnsRequest(request, { topicArn, label, handle }) {
	if (!topicArn) return reply(503, { error: "Webhook is not configured" });

	const body = await request.text();
	if (body.length > MAX_BODY_LENGTH) return reply(413, { error: "Body is too large" });
	const message = parseJson(body);
	if (!isPlainObject(message)) return reply(400, { error: "Invalid JSON" });
	if (message.TopicArn !== topicArn) return reply(403, { error: "Unknown topic" });
	if (!(await verifySnsMessage(message))) return reply(400, { error: "Invalid signature" });

	if (message.Type === "SubscriptionConfirmation") return confirmSubscription(message, label);
	if (message.Type === "Notification") return handleNotification(message, { label, handle });
	return reply(200, { ok: true });
}
