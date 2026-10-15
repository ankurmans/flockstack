// CNAMEs and TXT records set by tests instead of looked up. A TXT record set to null is a lookup that failed.
export const cnames = new Map();
export const txts = new Map();

export async function readCnames(host) {
	return cnames.get(host) ?? [];
}

export async function readTxt(host) {
	return txts.has(host) ? txts.get(host) : [];
}
