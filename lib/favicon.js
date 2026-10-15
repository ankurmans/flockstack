// Google's resolver returns a sized PNG for any domain, and a generic globe when it finds none.
export function faviconUrl(domain, size = 64) {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
