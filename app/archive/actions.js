"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { isSendingEnabled } from "@/lib/config";
import { getSignupProblem, upsertContact } from "@/lib/contacts";
import { buildFieldUpdate, parseFieldValue } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { getInbox } from "@/lib/inbox-links";
import { findSignupNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { countSignup, findAttribution, getReaderStep, subscribeToRecommended } from "@/lib/recommendations";
import { recordReferral } from "@/lib/referrals";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { normalizeEmail } from "@/lib/validation";
import CustomField from "@/models/CustomField";

const PER_IP = { name: "subscribe-ip", limit: 5, window: "10 m" };
// The "You might also like" step signs a reader up to several newsletters at once, so it has its own cap.
const PER_IP_RECOMMENDED = { name: "recommend-ip", limit: 6, window: "10 m" };
// Only alerts: refusing signups past a shared limit would let one flooder block every real signup.
// A flood from many IPs (list bombing) still needs a look: it fills the list with spam traps.
const PER_NEWSLETTER = { name: "subscribe-newsletter", limit: 300, window: "10 m" };

export async function subscribe(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true };

	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email" };

	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) {
		return { error: "Too many signups from your network. Try again in a few minutes." };
	}
	const emailProblem = await getSignupProblem(email);
	if (emailProblem) return { error: emailProblem };

	await connectDb();
	const newsletter = await findSignupNewsletter({
		slug: String(formData.get("newsletter") ?? ""),
		archiveEnabled: true,
	});
	if (!newsletter) return { error: "This newsletter is not taking signups" };

	// Visitors only ever fill in the fields the form asks for, and never tags.
	const definitions = await CustomField.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, onSignupForm: true }).lean();
	const values = {};
	for (const { key, label, type } of definitions) {
		const value = String(formData.get(`field_${key}`) ?? "").trim();
		if (!value) continue;
		const { problem } = parseFieldValue(type, value);
		if (problem) return { error: `${label} ${problem}` };
		values[key] = value;
	}
	const fieldUpdate = buildFieldUpdate(definitions, values);

	if (await isRateLimited({ ...PER_NEWSLETTER, key: newsletter.slug })) {
		after(() =>
			sendAlert({
				accountId: newsletter.accountId,
				key: `signup-flood:${newsletter.slug}`,
				title: "Website signup flood",
				detail: `Over ${PER_NEWSLETTER.limit} signups to ${newsletter.name} in 10 minutes. They still go through (${PER_IP.limit} per visitor per 10 minutes); check new contacts for junk.`,
				path: "/contacts",
			})
		);
	}

	const ip = getClientIp(await headers());
	// A visitor who followed another newsletter's recommendation: the signup is counted for it (lib/recommendations.js).
	const recommended = await findAttribution({ newsletter, slug: String(formData.get("rec") ?? "") }).catch(() => null);
	const { contact, created } = await upsertContact({ newsletter, email, source: recommended?.source ?? "website", resubscribe: true, fieldUpdate });
	if (recommended && created && contact.status !== "unsubscribed" && contact.status !== "bounced" && contact.status !== "complained") {
		await countSignup({ recommender: recommended.recommender, recommendedId: newsletter._id, isConfirmed: contact.status === "active" }).catch((error) =>
			console.error(`[subscribe] Recommendation signup for ${contact._id} not counted:`, error.message)
		);
	}
	// A signup through a subscriber's referral link: counted once the new subscriber confirms.
	const referralCode = String(formData.get("ref") ?? "").trim();
	if (referralCode && created) {
		after(() =>
			recordReferral({ newsletter, contact, created, code: referralCode, ip }).catch((error) =>
				console.error(`[subscribe] Referral for ${contact._id} not recorded:`, error.message)
			)
		);
	}
	const isPending = contact.status === "pending";
	if (isSendingEnabled() && (isPending || (created && contact.status === "active"))) {
		const queue = isPending ? queueConfirmationEmail : queueWelcomeEmail;
		after(() =>
			queue({ newsletter, contact }).catch((error) =>
				console.error(`[subscribe] Signup email for ${contact._id} failed:`, error.message)
			)
		);
	}
	if (!isPending) {
		const step = await getStep({ newsletter, contact });
		return { ok: true, ...(step && { step }) };
	}
	return { ok: true, pending: true, email, inbox: getInbox({ email, fromEmail: newsletter.fromEmail }) };
}

// The newsletters this one recommends, for the reader who just joined. Never fails the signup.
async function getStep({ newsletter, contact }) {
	try {
		return await getReaderStep({ newsletter, contact });
	} catch (error) {
		console.error(`[subscribe] Recommendations for ${newsletter.slug} not loaded:`, error.message);
		return null;
	}
}

// The ticks on the "You might also like" step: a signup to each ticked newsletter through its own flow, with its own
// confirmation email. Nothing is shared with a newsletter the reader didn't tick.
export async function subscribeToRecommendations(token, _state, formData) {
	if (await isRateLimited({ ...PER_IP_RECOMMENDED, key: getClientIp(await headers()) })) {
		return { error: "Too many signups from your network. Try again in a few minutes." };
	}
	const outcome = await subscribeToRecommended({ token, slugs: formData.getAll("newsletter").map(String) });
	if (outcome.error) return { error: outcome.error };
	if (outcome.results.length === 0) return { error: "Those newsletters aren't taking signups right now. Try again later." };
	if (isSendingEnabled()) {
		for (const { newsletter, contact, created, isPending } of outcome.results) {
			if (!isPending && !created) continue;
			const queue = isPending ? queueConfirmationEmail : queueWelcomeEmail;
			after(() =>
				queue({ newsletter, contact }).catch((error) => console.error(`[subscribe] Signup email for ${contact._id} failed:`, error.message))
			);
		}
	}
	return { ok: true, joined: outcome.results.map(({ newsletter, isPending }) => ({ name: newsletter.name, isPending })) };
}
