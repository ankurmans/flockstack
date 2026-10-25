// What a request gets when the app throws instead of answering (worker-entry.mjs): the router turns an exception into a bare 502, and
// an OAuth client that gets one starts over with the user signing in. JSON in the API's error shape for the API, MCP, OAuth and
// discovery paths, plain text for the rest; 503 with retry-after, which clients and the router take for "try again".
const MESSAGE = "FlockStack could not answer this request. Try again in a moment.";
const API_PATH = /^\/(mcp|api|\.well-known)(\/|$)/;

export function unavailableResponse(pathname) {
	const headers = { "cache-control": "no-store", "retry-after": "5" };
	if (API_PATH.test(pathname)) return Response.json({ error: { code: "unavailable", message: MESSAGE } }, { status: 503, headers });
	return new Response(`${MESSAGE}\n`, { status: 503, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
}
