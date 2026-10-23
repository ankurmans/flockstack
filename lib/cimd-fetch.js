// How the server fetches a client's metadata document (Client ID Metadata Documents: Claude Code and other MCP clients use an
// https address as their client_id). The package's Node fetcher resolves the name with node:dns and pins the address on a
// node:https request, which Cloudflare Workers can't do: every fetch failed there, and Claude Code's sign-in ended in "Failed to
// fetch metadata document". A Worker's own fetch never reaches a private or internal address (the global_fetch_strictly_public
// flag in wrangler.jsonc), so it only needs the checks the pinning was for: https, a public-looking name, GET or HEAD, and redirects
// handed back to the plugin, which refuses them.

export function isWorkersRuntime() {
	return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

// A client_id on a bare name, an address, or a name that only exists inside a network is never a public client.
export function isPublicClientHostname(hostname) {
	const name = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
	if (!name || name.startsWith("[") || /^[0-9.]+$/.test(name)) return false;
	if (!name.includes(".")) return false;
	return !/\.(?:localhost|local|internal|lan|home|corp|intranet)$/.test(name);
}

export const fetchClientMetadataResourceOnWorkers = async (input, init) => {
	// The plugin asks for redirect: "error", which Workers' Request refuses (only "follow" and "manual" exist there): every fetch
	// died as a "network error". Redirects are never followed here, they come back as the 3xx answer, which the plugin rejects.
	const { redirect: _wanted, ...rest } = init ?? {};
	const request = new Request(input, { ...rest, redirect: "manual" });
	const url = new URL(request.url);
	if (url.protocol !== "https:") throw new TypeError("CIMD transport requires an HTTPS URL");
	if (request.method !== "GET" && request.method !== "HEAD") throw new TypeError("CIMD transport supports only GET and HEAD");
	if (!isPublicClientHostname(url.hostname)) throw new TypeError("metadata hostname must be a public name");
	return fetch(request, { redirect: "manual", signal: init?.signal ?? request.signal });
};

// The Worker's fetcher on Cloudflare, the package's pinned Node one everywhere else (self-hosted servers run on Node).
export async function getClientMetadataFetcher() {
	if (isWorkersRuntime()) return fetchClientMetadataResourceOnWorkers;
	const { fetchClientMetadataResource } = await import("@better-auth/cimd/node");
	return fetchClientMetadataResource;
}
