import "server-only";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

// Addresses a server must never fetch for a customer: loopback, private networks, link-local (cloud
// metadata), carrier-grade NAT, documentation, multicast and reserved ranges.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
]) {
	BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
]) {
	BLOCKED.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return !BLOCKED.check(address, "ipv4");
	if (family !== 6) return false;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	return mapped ? isPublicAddress(mapped) : !BLOCKED.check(address, "ipv6");
}

function fetchError(message) {
	return Object.assign(new Error(message), { code: "validation_failed" });
}

function formatLimit(maxBytes) {
	return maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${Math.round(maxBytes / 1024)} KB`;
}

// Checked when the connection opens, so a host can't answer the check with one address and the
// download with another.
function publicLookup(hostname, options, callback) {
	dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error);
		if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
			return callback(fetchError("The link points at an address FlockStack can't reach"));
		}
		if (options.all) return callback(null, addresses);
		return callback(null, addresses[0].address, addresses[0].family);
	});
}

function get(url, accept) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { lookup: publicLookup, timeout: TIMEOUT_MS, headers: { accept } }, resolve);
		request.on("timeout", () => request.destroy(fetchError("The link took too long to answer")));
		request.on("error", reject);
	});
}

async function readBody(response, maxBytes, tooLarge) {
	const chunks = [];
	let size = 0;
	for await (const chunk of response) {
		size += chunk.length;
		if (size > maxBytes) {
			response.destroy();
			throw fetchError(tooLarge);
		}
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

// What a link has to be before FlockStack opens it for a customer: https on the standard port, no credentials, and not an
// address of a private network. A host name is checked again when the connection opens (publicLookup). Answers the URL.
export function checkPublicUrl(link) {
	let url;
	try {
		url = new URL(link);
	} catch {
		throw fetchError("url must be an https:// link");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
		throw fetchError("url must be an https:// link on the standard port");
	}
	if (net.isIP(hostname) && !isPublicAddress(hostname)) throw fetchError("The link points at an address FlockStack can't reach");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || !hostname.includes(".")) {
		throw fetchError("The link points at an address FlockStack can't reach");
	}
	return url;
}

// A file behind a public https:// link, up to maxBytes, following a few redirects, each checked like the first.
export async function fetchRemoteFile(link, { maxBytes, accept = "*/*", label = "Files" }) {
	const tooLarge = `${label} must be under ${formatLimit(maxBytes)}`;
	let url = checkPublicUrl(link);
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const response = await get(url, accept);
		const location = response.headers.location;
		if (response.statusCode >= 300 && response.statusCode < 400 && location) {
			response.resume();
			url = checkPublicUrl(new URL(location, url).href);
			continue;
		}
		if (response.statusCode !== 200) {
			response.resume();
			throw fetchError(`The link answered ${response.statusCode}`);
		}
		if (Number(response.headers["content-length"]) > maxBytes) {
			response.destroy();
			throw fetchError(tooLarge);
		}
		return readBody(response, maxBytes, tooLarge);
	}
	throw fetchError("The link redirects too many times");
}

export function fetchRemoteImage(link, { maxBytes }) {
	return fetchRemoteFile(link, { maxBytes, accept: "image/*", label: "Images" });
}
