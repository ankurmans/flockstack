import { getDomain } from "tldts";

// The registrable domain, from the Public Suffix List: example.co.uk for news.example.co.uk, the DNS zone its records
// go in. Private suffixes count too (example.us.com): their registries give each customer a zone of their own.
export function rootDomain(hostOrEmail) {
	const host = String(hostOrEmail ?? "")
		.toLowerCase()
		.split("@")
		.pop()
		.trim()
		.replace(/\.$/, "");
	return getDomain(host, { allowPrivateDomains: true }) ?? host;
}
