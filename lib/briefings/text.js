// Small text rules shared by extract and check: numbers as a comparable form, quotes and word counts.
const NUMBER = /\d[\d,.]*\d|\d/g;

// "1,234.50" -> "1234.5", "07" -> "7": the same figure written two ways compares equal.
export function normalizeNumber(token) {
	const plain = String(token).replace(/,(?=\d{3}(?:\D|$))/g, "").replace(/[.,]+$/, "");
	if (!/^\d+(?:\.\d+)?$/.test(plain)) return plain;
	return String(Number(plain));
}

export function numbersIn(text) {
	return [...String(text ?? "").matchAll(NUMBER)].map(([token]) => normalizeNumber(token));
}

export function wordCount(text) {
	return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

// The quoted passages of a text, straight or curly quotes.
export function quotesIn(text) {
	return [...String(text ?? "").matchAll(/[“"]([^”"\n]{2,}?)[”"]/g)].map((match) => match[1].trim());
}

// Text compared loosely: curly quotes straightened, spacing collapsed, case ignored.
export function looseText(text) {
	return String(text ?? "")
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}
