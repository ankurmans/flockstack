import { readUtm, serializeAttributionInput, toReferrerHost } from "@/lib/attribution";

// localStorage throws when the browser blocks storage; the archive then just forgets.
export function readStoredNumber(key) {
	try {
		return Number(localStorage.getItem(key)) || 0;
	} catch {
		return 0;
	}
}

export function storeValue(key, value) {
	try {
		localStorage.setItem(key, String(value));
	} catch {}
}

export function subscribedKey(newsletterSlug) {
	return `flockstack:subscribed:${newsletterSlug}`;
}

// The referral code a visitor arrived with, kept for 30 days so they can read an issue or two before signing up.
export function referralKey(newsletterSlug) {
	return `flockstack:referral:${newsletterSlug}`;
}

const REFERRAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{27}$/;

// The code in the address's ?ref=, kept for later pages; else the one kept. Empty for a visitor who wasn't referred.
export function captureReferralCode(newsletterSlug) {
	try {
		const key = referralKey(newsletterSlug);
		const fromUrl = new URLSearchParams(window.location.search).get("ref");
		if (fromUrl && REFERRAL_CODE_PATTERN.test(fromUrl)) {
			localStorage.setItem(key, JSON.stringify({ code: fromUrl, at: Date.now() }));
			return fromUrl;
		}
		const stored = JSON.parse(localStorage.getItem(key) ?? "null");
		return stored && Date.now() - stored.at < REFERRAL_MAX_AGE_MS ? stored.code : "";
	} catch {
		return "";
	}
}

const RECOMMENDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECOMMENDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// The slug of the newsletter whose recommendation brought the visitor (?rec= in the address), kept for 7 days. Empty for a
// visitor who didn't come from one. The server checks it again: it only counts for a recommendation that exists.
export function captureRecommender(newsletterSlug) {
	try {
		const key = `flockstack:recommender:${newsletterSlug}`;
		const fromUrl = new URLSearchParams(window.location.search).get("rec");
		if (fromUrl && RECOMMENDER_PATTERN.test(fromUrl)) {
			localStorage.setItem(key, JSON.stringify({ slug: fromUrl, at: Date.now() }));
			return fromUrl;
		}
		const stored = JSON.parse(localStorage.getItem(key) ?? "null");
		return stored && Date.now() - stored.at < RECOMMENDER_MAX_AGE_MS ? stored.slug : "";
	} catch {
		return "";
	}
}

const ATTRIBUTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Where the visitor came from, for the signup form to hand over (lib/attribution.js): the UTM parameters of the address,
// kept for 30 days so an issue or two can be read first, and the host of the page that linked here. A new address with
// UTM parameters replaces what was kept; otherwise the first outside referrer is kept. "" when there is nothing to say.
export function captureAttribution(newsletterSlug) {
	try {
		const key = `flockstack:attribution:${newsletterSlug}`;
		const params = new URLSearchParams(window.location.search);
		const utm = readUtm((name) => params.get(name));
		const referrer = toReferrerHost(document.referrer, [window.location.hostname]);
		const stored = JSON.parse(localStorage.getItem(key) ?? "null");
		const fresh = stored && Date.now() - stored.at < ATTRIBUTION_MAX_AGE_MS ? stored : null;
		if (utm || (referrer && !fresh)) {
			const next = { ...(utm && { utm }), ...(referrer && { referrer }), at: Date.now() };
			localStorage.setItem(key, JSON.stringify(next));
			return serializeAttributionInput(next);
		}
		return fresh ? serializeAttributionInput(fresh) : "";
	} catch {
		return "";
	}
}

export function subscribeSnoozedKey(newsletterSlug) {
	return `flockstack:subscribe-snoozed:${newsletterSlug}`;
}

// The gated issue a reader signed up on, kept so the page that confirms them can lead back to it. A path on this site.
export function gateReturnKey(newsletterSlug) {
	return `flockstack:gate-return:${newsletterSlug}`;
}

const GATE_RETURN_PATTERN = /^\/(archive\/[a-z0-9-]{1,40}\/)?p\/[a-z0-9][a-z0-9-]{0,119}$/;

export function readGateReturn(newsletterSlug) {
	try {
		const path = localStorage.getItem(gateReturnKey(newsletterSlug)) ?? "";
		return GATE_RETURN_PATTERN.test(path) ? path : "";
	} catch {
		return "";
	}
}
