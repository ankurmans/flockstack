import { getPrivateHostProblem } from "./webhook-url.js";

// Whether a name the account typed (an AI key's own server, a candidate feed) may be fetched from FlockStack's servers: every address
// it resolves to has to be public, the rule lib/briefings/fetch.js applies to every page. A Worker has no resolver of its own, so there
// it asks DNS over HTTPS; on a self-hosted Node server, the system's. Tests set their own resolver (setHostResolver): no DNS in tests.
const DOH = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 5000;
let resolver = null;

export function setHostResolver(resolve) {
	resolver = resolve;
}

async function resolveHost(host) {
	if (resolver) return resolver(host);
	if (globalThis.navigator?.userAgent === "Cloudflare-Workers") {
		const answers = await Promise.all(
			["A", "AAAA"].map(async (type) => {
				const response = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
				if (!response.ok) throw new Error("DNS didn't answer");
				const body = await response.json();
				return (body?.Answer ?? []).filter((answer) => answer?.type === 1 || answer?.type === 28).map((answer) => String(answer.data));
			})
		);
		return answers.flat();
	}
	const { lookup } = await import("node:dns/promises");
	return (await lookup(host, { all: true })).map(({ address }) => address);
}

// Why the URL's host can't be fetched (a private address, or a name that resolves to one or to nothing), or null.
export async function getResolvedHostProblem(url) {
	const direct = getPrivateHostProblem(url);
	if (direct) return direct;
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
	let addresses;
	try {
		addresses = await resolveHost(host);
	} catch {
		return "That name doesn't resolve";
	}
	if (!addresses?.length) return "That name doesn't resolve";
	for (const address of addresses) {
		const problem = getPrivateHostProblem(new URL(`https://${address.includes(":") ? `[${address}]` : address}/`));
		if (problem) return "That name points inside a private network: use a public one";
	}
	return null;
}
