import { hasReaderBillingFeatures, readReaderBillingAccess } from "@/lib/reader-billing-access";
import { getClientIp } from "@/lib/rate-limit";
import { openSubscriberPortal } from "@/lib/shop";

function page(status, message) {
	return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Manage your subscription</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.25rem;line-height:1.5"><p>${message}</p></body>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
	});
}

// "Manage your subscription" in a paid reader's emails: a link signed for one contact (lib/portal-link.js) that sends them to
// their billing page at Stripe. Opens without a session, on the newsletter's host or the app's.
export async function GET(request) {
	const token = new URL(request.url).searchParams.get("token");
	try {
		const context = await readReaderBillingAccess(token);
		const existing = !hasReaderBillingFeatures(context.newsletter) && await (await import("@/models/ReaderRetention")).default.exists({ accountId: context.account._id, newsletterId: context.newsletterId, contactId: context.contactId });
		if (hasReaderBillingFeatures(context.newsletter) || existing) return new Response(null, { status: 302, headers: { location: `/reader/billing?token=${encodeURIComponent(token)}`, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
	} catch { /* The original portal path supplies its existing error and rate limit. */ }
	const { url, error } = await openSubscriberPortal({ token: new URL(request.url).searchParams.get("token"), ip: getClientIp(request.headers) });
	if (url) return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
	return page(error?.startsWith("Too many") ? 429 : 410, error);
}
