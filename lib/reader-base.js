// The base of a reader page's own requests. A newsletter's website served from a subfolder of its owner's site gets the mount path
// on <html data-base> from the Worker (lib/mount-rewrite.js), and its requests to FlockStack go under it, through the owner's proxy;
// everywhere else it is empty and they go to the page's own host.
export function getReaderBase() {
	if (typeof document === "undefined") return "";
	return document.documentElement.dataset.base ?? "";
}

export function withReaderBase(path) {
	return `${getReaderBase()}${path}`;
}

// The page's path as the newsletter's host would have it, without the subfolder.
export function getReaderPathname(pathname) {
	const base = getReaderBase();
	return base && (pathname === base || pathname.startsWith(`${base}/`)) ? pathname.slice(base.length) || "/" : pathname;
}
