// The page a ?page= asks for: a whole number from 1; anything else is the first page.
export function readPageNumber(value) {
	const number = Number(typeof value === "string" ? value : "");
	return Number.isInteger(number) && number >= 1 && number <= 10_000 ? number : 1;
}
