// Where FlockStack may POST an account's events. The request leaves from FlockStack's own servers, so an address inside a
// network (loopback, private ranges, a cloud's metadata service) would let anyone with an account reach it. Only https on
// the default port, to a name or a public address. A name is checked as written: on Cloudflare Workers a fetch can't
// reach private addresses whatever the name resolves to.
export const MAX_WEBHOOK_URL_LENGTH = 2000;

const BLOCKED_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".cluster.local"];

// [first address, prefix length] for IPv4 ranges that aren't the public internet.
const PRIVATE_V4 = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function toV4Number(address) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateV4(address) {
	const value = toV4Number(address);
	if (value === null) return false;
	return PRIVATE_V4.some(([start, bits]) => {
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return ((value & mask) >>> 0) === ((toV4Number(start) & mask) >>> 0);
	});
}

// The URL parser has already turned the address into its canonical form: lowercase hex, :: compressed.
function isPrivateV6(address) {
	if (address === "::" || address === "::1") return true;
	const mapped = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (mapped) {
		const high = Number.parseInt(mapped[1], 16);
		const low = Number.parseInt(mapped[2], 16);
		return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
	}
	const first = Number.parseInt(address.split(":")[0] || "0", 16);
	// fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation, 64:ff9b::/96 NAT64.
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || address.startsWith("2001:db8:") || address.startsWith("64:ff9b:");
}

// What's wrong with an address for a webhook, or null when it can take events.
export function getWebhookUrlProblem(value) {
	const text = String(value ?? "").trim();
	if (!text) return "Enter the address to send events to";
	if (text.length > MAX_WEBHOOK_URL_LENGTH) return `The address can be ${MAX_WEBHOOK_URL_LENGTH} characters at most`;
	let url;
	try {
		url = new URL(text);
	} catch {
		return "Enter a full address, starting with https://";
	}
	if (url.protocol !== "https:") return "The address has to start with https://";
	if (url.username || url.password) return "Leave the user name and password out of the address";
	if (url.port) return "Use the default https port: leave the port out of the address";
	return getPrivateHostProblem(url);
}

// Why a parsed https URL's host is a private network, or null for a public name or address. Webhooks, RSS feeds and
// every other fetch FlockStack makes for a customer share it.
export function getPrivateHostProblem(url) {
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[")) {
		return isPrivateV6(host.slice(1, -1)) ? "That address is inside a private network: use a public one" : null;
	}
	if (toV4Number(host) !== null) return isPrivateV4(host) ? "That address is inside a private network: use a public one" : null;
	if (!host.includes(".") || BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return "That name only works inside a private network: use a public address";
	}
	return null;
}

// The address as it's stored and shown: trimmed, with the parser's normal form.
export function normalizeWebhookUrl(value) {
	return new URL(String(value).trim()).toString();
}
