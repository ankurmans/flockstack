// The "Cookie settings" link in the footer and on the sign-in page (FooterCookies) opens the banner that
// ProviderAnalytics renders. The link shows only on a page where that banner can open: not on the pages without
// analytics, and not for a visitor whose browser sends a privacy signal.
export const COOKIE_SETTINGS_EVENT = "flockstack:cookie-settings";

let isAvailable = false;
const listeners = new Set();

export function setCookieSettingsAvailable(value) {
	if (isAvailable === value) return;
	isAvailable = value;
	for (const listener of listeners) listener();
}

export function subscribeCookieSettings(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getCookieSettingsAvailable() {
	return isAvailable;
}

export function openCookieSettings() {
	window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
}
