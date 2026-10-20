"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { subscribeToRecommended } from "@/lib/recommendations";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { WEBSITE_SOURCES, signUp } from "@/lib/signup";

// The "You might also like" step signs a reader up to several newsletters at once, so it has its own cap.
const PER_IP_RECOMMENDED = { name: "recommend-ip", limit: 6, window: "10 m" };

// The newsletter's own signup form, on its pages and in its popup. "via" says which; nothing else sets a source.
export async function subscribe(_state, formData) {
	const via = String(formData.get("via") ?? "");
	return signUp({
		formData,
		ip: getClientIp(await headers()),
		source: WEBSITE_SOURCES.includes(via) ? via : "website",
	});
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
