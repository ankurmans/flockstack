"use server";

import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { countConfirmation, getReaderStep } from "@/lib/recommendations";
import { startReaderSession } from "@/lib/reader-session";
import { creditReferral } from "@/lib/referrals";
import { queueWelcomeEmail } from "@/lib/sending";

export async function confirmSubscription(token) {
	const reference = verifyConfirmToken(token);
	if (!reference) return { error: "invalid" };

	await connectDb();
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	if (!newsletter) return { error: "invalid" };
	const { contact, confirmed } = await confirmContact({ accountId: newsletter.accountId, ...reference });
	// Confirmed, and now waiting for the owner (Newsletter.signupApproval): no session, no welcome, no credit yet.
	if (contact?.status === "held") return { ok: true, held: true };
	if (contact?.status !== "active") return { error: "invalid" };
	// The link proved the address, so the browser can sign in to the website as this subscriber (a gated issue opens).
	await startReaderSession(newsletter, contact._id);

	// The referrer's count and rewards, when this subscriber came through someone's referral link.
	if (confirmed) {
		after(() =>
			creditReferral({ newsletter, contact }).catch((error) => console.error(`[confirm] Referral for ${contact._id} not credited:`, error.message))
		);
	}
	if (confirmed) {
		after(() =>
			countConfirmation({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Recommendation for ${contact._id} not counted:`, error.message)
			)
		);
	}
	if (confirmed && isSendingEnabled()) {
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		after(() =>
			queueWelcomeEmail({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Welcome email for ${contact._id} failed:`, error.message)
			)
		);
	}
	// The newsletters this one recommends, offered once the subscriber has proved their address.
	const step = await getReaderStep({ newsletter, contact }).catch((error) => {
		console.error(`[confirm] Recommendations for ${newsletter.slug} not loaded:`, error.message);
		return null;
	});
	return { ok: true, ...(step && { step }), ...(newsletter.confirmedRedirectUrl && { redirectUrl: newsletter.confirmedRedirectUrl }) };
}
