// Stable assignment shared by automation branches and email tests, without loading their schemas.
// cyrb53 gives the same fraction in [0, 1) for a string, so retries keep the same allocation.
export function hashToUnit(text) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 2 ** 53;
}

// Which path of a split a seed takes, by the paths' percents: the same seed always takes the same path.
export function pickSplitPath(percents, seed) {
	const point = hashToUnit(String(seed)) * 100;
	let from = 0;
	for (const [index, percent] of percents.entries()) {
		from += percent;
		if (point < from) return index;
	}
	return percents.length - 1;
}
