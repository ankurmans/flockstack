import "server-only";
import { NextResponse } from "next/server";
import { sendAlertIfRepeated } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { handleEmailEvent } from "@/lib/email-events";
import { normalizePostshibaEvent, verifyPostshibaSignature } from "@/lib/email-provider/postshiba-events";
import Account from "@/models/Account";

// PostShiba posts one event per request; a long array is someone else's.
const MAX_BODY_BYTES = 512 * 1024;
const MAX_EVENTS = 100;

function reply(status, body) {
	return NextResponse.json(body, { status });
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// The account the unique args name, if PostShiba's tenant on the event is that account's own; else the
// account whose tenant it is. An event never lands in an account its tenant doesn't belong to.
async function findEventAccount(event) {
	if (event.accountId) {
		const account = await Account.findById(event.accountId).select({ "postshiba.tenantSlug": 1 }).lean();
		if (!account || (event.tenant && account.postshiba?.tenantSlug !== event.tenant)) return null;
		return account;
	}
	return event.tenant ? Account.findOne({ "postshiba.tenantSlug": event.tenant }).select({ _id: 1 }).lean() : null;
}

export async function handlePostshibaEvent(raw) {
	const event = normalizePostshibaEvent(raw);
	if (!event) return { handled: false };
	await connectDb();
	const account = await findEventAccount(event);
	if (!account) {
		if (event.type !== "sent" && event.type !== "delivered") {
			console.warn(`[postshiba-webhook] ${event.recordAs} for no known account (tenant ${event.tenant ?? "none"})`);
		}
		return { handled: true, accountId: null };
	}
	const result = await handleEmailEvent({ ...event, accountId: account._id }, { isAccountTrusted: true });
	// PostShiba gets a 200 either way, so a message that can't be matched would otherwise go unseen.
	if (result.handled && event.messageId && !result.messageId) {
		console.warn(`[postshiba-webhook] ${event.recordAs} for account ${account._id}: no message ${event.messageId} with PostShiba id ${event.providerMessageId ?? "none"}`);
	}
	return { ...result, accountId: String(account._id) };
}

// Delivery events of every tenant (/api/webhooks/postshiba). Checked against the raw bytes before parsing.
// A 5xx makes PostShiba retry (6 attempts over about a day); every handler is safe to replay.
export async function handlePostshibaRequest(request) {
	const secret = process.env.POSTSHIBA_WEBHOOK_SECRET;
	if (!secret) return reply(503, { error: "Webhook is not configured" });
	const body = Buffer.from(await request.arrayBuffer());
	if (body.length > MAX_BODY_BYTES) return reply(413, { error: "Body is too large" });
	const isSigned = verifyPostshibaSignature({
		body,
		timestamp: request.headers.get("x-capsule-timestamp"),
		signature: request.headers.get("x-capsule-signature"),
		secret,
	});
	if (!isSigned) return reply(401, { error: "Invalid signature" });

	const events = parseJson(body.toString("utf8"));
	if (!Array.isArray(events) || events.length > MAX_EVENTS) return reply(400, { error: "Expected an array of events" });
	try {
		let handled = 0;
		for (const event of events) if ((await handlePostshibaEvent(event)).handled) handled++;
		return reply(200, { ok: true, handled });
	} catch (error) {
		console.error("[postshiba-webhook] Could not handle the events:", error);
		await sendAlertIfRepeated("postshiba-webhook", {
			accountId: null,
			key: "webhook-failing:postshiba-webhook",
			title: "Webhook failing",
			detail: `postshiba-webhook couldn't handle 3 events within an hour: ${String(error?.message ?? error).slice(0, 300)}.`,
			action: "PostShiba retries each one 6 times over about a day; until then bounces and complaints go uncounted.",
			link: "https://app.postshiba.com",
		});
		return reply(500, { error: "Could not handle the events" });
	}
}
