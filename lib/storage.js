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
	return `mailcheap:subscribed:${newsletterSlug}`;
}

export function subscribeSnoozedKey(newsletterSlug) {
	return `mailcheap:subscribe-snoozed:${newsletterSlug}`;
}
