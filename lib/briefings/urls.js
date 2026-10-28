// How a briefing tells one address from another (docs/BRIEFINGS-DESIGN.md, Dedupe): the same story reached through a
// tracking link, an AMP copy or a fragment counts once.
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "ref", "amp", "outputtype"]);

export function canonicalUrl(value) {
	let url;
	try {
		url = new URL(String(value ?? "").trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	url.hash = "";
	url.hostname = url.hostname.toLowerCase().replace(/^amp\./, "");
	for (const name of [...url.searchParams.keys()]) {
		const lower = name.toLowerCase();
		if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) url.searchParams.delete(name);
	}
	const segments = url.pathname.split("/").filter((segment) => segment.toLowerCase() !== "amp");
	url.pathname = segments.join("/").replace(/\.amp(\.html?)?$/i, "$1") || "/";
	return url.href.replace(/\?$/, "");
}

export async function sha256Hex(text) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hostOf(value) {
	try {
		return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

// Same site: the same host, or one a subdomain of the other's registrable part (blog.example.com and example.com).
export function isSameSite(a, b) {
	const first = hostOf(a);
	const second = hostOf(b);
	if (!first || !second) return false;
	if (first === second) return true;
	const base = (host) => host.split(".").slice(-2).join(".");
	return base(first) === base(second);
}
