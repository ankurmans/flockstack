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

export function subscribeSnoozedKey(newsletterSlug) {
	return `flockstack:subscribe-snoozed:${newsletterSlug}`;
}
