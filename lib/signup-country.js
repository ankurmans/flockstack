// The country a signup came from, for segments. Cloudflare puts it in cf-ipcountry on every request it proxies; "XX"
// means it doesn't know and "T1" is Tor. Only these two letters are ever kept, never the address they came from.
export function readCountry(value) {
	const code = String(value ?? "").trim().toUpperCase();
	return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
}

export function getHeaderCountry(headers) {
	return readCountry(headers?.get?.("cf-ipcountry"));
}
