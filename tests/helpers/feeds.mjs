import { readFileSync } from "node:fs";

// The feeds a test reads, answered from memory: routes maps an address to a body, a { status, headers, body } or a function
// returning either. Anything else goes to the fetch that was there. requests lists the addresses asked for, in order.
export function readFixture(name) {
	return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

export function serveFeeds(routes) {
	const previous = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input?.url ?? input);
		if (!routes.has(url)) return previous(input, init);
		requests.push({ url, init });
		const answer = typeof routes.get(url) === "function" ? await routes.get(url)() : routes.get(url);
		const { status = 200, headers = {}, body = "" } = typeof answer === "string" ? { body: answer } : answer;
		return new Response(body, { status, headers: { "content-type": "application/rss+xml", ...headers } });
	};
	return { requests, restore: () => (globalThis.fetch = previous) };
}
