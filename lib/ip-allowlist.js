// An API key's IP allow-list (ApiKey.allowedIps): IPv4 and IPv6 addresses and CIDR ranges. Plain, so the tests and the form read it.
export const MAX_ALLOWED_IPS = 20;

function parseIpv4(text) {
	const parts = text.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
	return parts.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function parseIpv6(text) {
	const value = text.toLowerCase();
	if (!/^[0-9a-f:.]+$/.test(value) || (value.match(/::/g) ?? []).length > 1) return null;
	// An IPv4 address at the end (::ffff:192.0.2.1) is its last two groups.
	let groupsText = value;
	const lastColon = value.lastIndexOf(":");
	if (value.slice(lastColon + 1).includes(".")) {
		const v4 = parseIpv4(value.slice(lastColon + 1));
		if (v4 === null) return null;
		groupsText = `${value.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
	}
	const [left, right] = groupsText.includes("::") ? groupsText.split("::") : [groupsText, null];
	const leftGroups = left ? left.split(":") : [];
	const rightGroups = right ? right.split(":") : [];
	const missing = 8 - leftGroups.length - rightGroups.length;
	if (right !== null && missing < 1) return null;
	const groups = right === null ? leftGroups : [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.reduce((total, group) => (total << 16n) | BigInt(parseInt(group, 16)), 0n);
}

// { version, value } for an address, or null.
export function parseIp(text) {
	const value = String(text ?? "").trim();
	if (value.includes(":")) {
		const v6 = parseIpv6(value);
		return v6 === null ? null : { version: 6, value: v6 };
	}
	const v4 = parseIpv4(value);
	return v4 === null ? null : { version: 4, value: v4 };
}

// { version, value, bits } for an address or a range (an address is a range of one), or null when it is neither.
export function parseRange(text) {
	const [address, prefix, extra] = String(text ?? "").trim().split("/");
	if (extra !== undefined) return null;
	const ip = parseIp(address);
	if (!ip) return null;
	const size = ip.version === 4 ? 32 : 128;
	if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return null;
	const bits = prefix === undefined ? size : Number(prefix);
	if (bits > size) return null;
	return { ...ip, bits, size };
}

// The ranges in one canonical spelling, or the first entry that isn't one.
export function normalizeAllowList(entries) {
	const ranges = [];
	for (const entry of entries ?? []) {
		const range = parseRange(entry);
		if (!range) return { invalid: String(entry) };
		ranges.push(String(entry).trim().toLowerCase());
	}
	return { ranges: [...new Set(ranges)] };
}

function inRange(ip, range) {
	if (ip.version !== range.version) return false;
	const shift = BigInt(range.size - range.bits);
	return ip.value >> shift === range.value >> shift;
}

// Whether the address is in one of the ranges. An address that can't be read is never allowed.
export function isIpAllowed(address, ranges) {
	const ip = parseIp(address);
	if (!ip) return false;
	return ranges.some((entry) => {
		const range = parseRange(entry);
		return Boolean(range) && inRange(ip, range);
	});
}
