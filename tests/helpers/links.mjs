import { readClickToken } from "../../lib/tracking.js";

// The addresses an email's links lead to: a tracked link's click token decoded, any other link as it is.
export function decodeClickLinks(html) {
	return [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*"([^"]+)"/gi)].map(([, href]) => {
		const url = href.replaceAll("&amp;", "&");
		const token = /\/c\/([^/?#]+)$/.exec(url)?.[1];
		return (token && readClickToken(token)?.url) || url;
	});
}
