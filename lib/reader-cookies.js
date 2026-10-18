// The names of a reader's cookies, apart from the signing (lib/reader-links.js) so the page's own scripts can read them.
export function readerCookieName(slug) {
	return `fs_reader_${slug}`;
}

// The page can read this one: it says a session exists, so a visitor without one costs no request.
export function readerMarkerName(slug) {
	return `fs_reader_${slug}_on`;
}
