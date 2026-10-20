import { getPrivateHostProblem } from "./webhook-url.js";

export const MAX_FEED_URL_LENGTH = 1000;

// What's wrong with an address FlockStack would fetch as an RSS or Atom feed, or null. The request leaves from
// FlockStack's servers, so it is https on the default port to a public host, the same rule as a webhook's address.
export function getFeedUrlProblem(value) {
	const text = String(value ?? "").trim();
	if (!text) return "Enter the feed's address";
	if (text.length > MAX_FEED_URL_LENGTH) return `The address can be ${MAX_FEED_URL_LENGTH} characters at most`;
	let url;
	try {
		url = new URL(text);
	} catch {
		return "Enter a full address, starting with https://";
	}
	if (url.protocol !== "https:") return "The feed's address has to start with https://";
	if (url.username || url.password) return "Leave the user name and password out of the address";
	if (url.port) return "Use the default https port: leave the port out of the address";
	return getPrivateHostProblem(url);
}
