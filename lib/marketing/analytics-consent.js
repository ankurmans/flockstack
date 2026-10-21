import { getRegionForCountry, isEu } from "../region.js";

// When FlockStack's own analytics (PostHog) may run, and how a visitor's choice is kept. The server component
// (components/marketing/SiteAnalytics.jsx) and the browser (ProviderAnalytics.jsx) both read these rules, so they can't
// drift. Pure functions: no request or document of their own.

export const CONSENT_COOKIE = "fs_consent";
export const CONSENT_MAX_AGE = 365 * 24 * 3600;
export const ACCEPTED = "accepted";
export const DECLINED = "declined";

// Cloudflare's codes for a visitor it can't place (XX) and Tor (T1): not known to be outside the EU, so they are asked.
const UNPLACED_COUNTRIES = new Set(["XX", "T1"]);

// The EU/EEA, the UK and Switzerland (lib/region.js), and every visitor to the EU deployment, whoever they are, need to
// accept first. Everyone else gets the analytics by default.
export function requiresConsent({ country, env = process.env } = {}) {
	if (isEu(env)) return true;
	const code = String(country ?? "").trim().toUpperCase();
	return !code || UNPLACED_COUNTRIES.has(code) || getRegionForCountry(code) === "eu";
}

// Global Privacy Control (Sec-GPC: 1, navigator.globalPrivacyControl) and Do Not Track (DNT: 1) mean no analytics and no
// banner, whatever the country or an earlier choice.
export function hasPrivacySignal({ gpc, dnt } = {}) {
	const isOn = (value) => value === true || ["1", "yes"].includes(String(value ?? "").trim().toLowerCase());
	return isOn(gpc) || isOn(dnt);
}

// The same signals as the browser reports them.
export function readBrowserPrivacySignal(win = globalThis) {
	return hasPrivacySignal({
		gpc: win.navigator?.globalPrivacyControl,
		dnt: win.navigator?.doNotTrack ?? win.doNotTrack ?? win.navigator?.msDoNotTrack,
	});
}

// The cookie's value as a choice: anything but the two values counts as no choice.
export function toConsent(value) {
	return value === ACCEPTED || value === DECLINED ? value : null;
}

// "accepted", "declined" or null from a Cookie header or document.cookie.
export function readConsent(cookieString) {
	for (const part of String(cookieString ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === CONSENT_COOKIE) return toConsent(part.slice(index + 1).trim());
	}
	return null;
}

// "on": load PostHog. "ask": show the banner and load nothing. "off": load nothing and clear what it left.
export function getAnalyticsStatus({ requiresConsent: needsConsent, consent }) {
	if (consent === DECLINED) return "off";
	if (consent === ACCEPTED) return "on";
	return needsConsent ? "ask" : "on";
}

// What the server decides before sending any analytics markup: nothing at all for a privacy signal, otherwise the
// rule the browser applies again on its own.
export function decideAnalytics({ country, gpc, dnt, consent, env = process.env }) {
	if (hasPrivacySignal({ gpc, dnt })) return { show: false, reason: "privacy-signal" };
	const needsConsent = requiresConsent({ country, env });
	return { show: true, requiresConsent: needsConsent, consent: consent ?? null, status: getAnalyticsStatus({ requiresConsent: needsConsent, consent }) };
}

// The cookie behind the choice: first party, twelve months. Secure unless the page is plain http, which only a local
// development server is.
export function serializeConsentCookie(value, { secure = true } = {}) {
	if (value !== ACCEPTED && value !== DECLINED) throw new Error(`Not a consent choice: ${value}`);
	return `${CONSENT_COOKIE}=${value}; Max-Age=${CONSENT_MAX_AGE}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// PostHog's own cookies and storage keys: ph_<project key>_posthog, and __ph_ for its flags (opt-out, session).
const POSTHOG_KEY = /^(ph_|__ph_)/;
const OPT_OUT_KEY = /^__ph_opt_in_out_/;

// A host and its parents, down to the registered domain, since PostHog can set its cookie on either.
export function cookieDomains(hostname) {
	const labels = String(hostname ?? "").split(".").filter(Boolean);
	if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label))) return labels.length ? [labels.join(".")] : [];
	return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
}

// Deletes every ph_ cookie and local or session storage key. keepOptOut leaves PostHog's opt-out flag, which the page's
// live PostHog instance reads to stay quiet until the next page load clears it too.
export function clearAnalyticsStorage({ document: doc, storages = [], hostname = "", keepOptOut = false }) {
	const isWanted = (key) => POSTHOG_KEY.test(key) && !(keepOptOut && OPT_OUT_KEY.test(key));
	const names = String(doc?.cookie ?? "")
		.split(";")
		.map((part) => part.split("=")[0].trim())
		.filter(isWanted);
	for (const name of names) {
		for (const domain of [null, ...cookieDomains(hostname)]) {
			doc.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/${domain ? `; Domain=${domain}` : ""}`;
		}
	}
	for (const storage of storages) {
		try {
			const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(isWanted);
			for (const key of keys) storage.removeItem(key);
		} catch {
			// Storage can be blocked: then there is nothing of ours in it.
		}
	}
}
