// Extra headers a newsletter adds to its emails (beehiiv calls them custom headers). Only a short allowlist is accepted, so a
// writer can label their mail for filters and list tools but never change who it is from, how it is signed, or how a reader
// unsubscribes: those headers are FlockStack's and the provider's, and nothing here can name them.
export const CUSTOM_HEADER_LIMITS = { count: 10, name: 40, value: 200 };

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
// Printable ASCII only: a line break or a control character in a value is how a header injects another one.
const VALUE_PATTERN = /^[\x20-\x7e]+$/;
// Names that are allowed as they are. Any other name has to start with X-.
const NAMED_HEADERS = ["List-Id", "List-Archive", "List-Help", "List-Owner", "List-Subscribe", "Organization", "Keywords"];
// X- headers the providers and FlockStack write themselves.
const RESERVED_PREFIXES = ["x-ses-", "x-amz-", "x-postshiba", "x-feedback", "x-flockstack"];

function getNameProblem(name) {
	if (!name) return "a header needs a name";
	if (name.length > CUSTOM_HEADER_LIMITS.name || !NAME_PATTERN.test(name)) return `"${name.slice(0, 50).replace(/[^\x20-\x7e]/g, "?")}" isn't a header name: letters, digits and dashes, starting with a letter, ${CUSTOM_HEADER_LIMITS.name} characters at most`;
	const lower = name.toLowerCase();
	if (RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return `${name} is set by FlockStack or the email provider`;
	if (NAMED_HEADERS.some((allowed) => allowed.toLowerCase() === lower) || /^x-[a-z0-9]/.test(lower)) return null;
	return `${name} can't be changed here. Allowed: headers starting with X-, and ${NAMED_HEADERS.join(", ")}`;
}

function getValueProblem(name, value) {
	if (!value) return `${name} needs a value`;
	if (value.length > CUSTOM_HEADER_LIMITS.value) return `${name}: keep the value under ${CUSTOM_HEADER_LIMITS.value} characters`;
	if (!VALUE_PATTERN.test(value)) return `${name}: the value can only use plain letters, digits and punctuation, on one line`;
	return null;
}

// The headers to store, trimmed, or { problem } naming the first that can't be used. A name written twice (in any case) is a problem.
export function checkCustomHeaders(list) {
	const headers = [];
	const seen = new Set();
	for (const entry of list ?? []) {
		const name = String(entry?.name ?? "").trim();
		const value = String(entry?.value ?? "").trim();
		const problem = getNameProblem(name) ?? getValueProblem(name, value);
		if (problem) return { problem: `Custom headers: ${problem}` };
		if (seen.has(name.toLowerCase())) return { problem: `Custom headers: ${name} is there twice` };
		seen.add(name.toLowerCase());
		headers.push({ name, value });
	}
	if (headers.length > CUSTOM_HEADER_LIMITS.count) return { problem: `Custom headers: up to ${CUSTOM_HEADER_LIMITS.count}` };
	return { headers };
}

// What a send adds to an email: the stored headers that still pass, as an object. The caller puts the unsubscribe headers over it.
export function getCustomHeaders(newsletter) {
	const entries = (newsletter?.customHeaders ?? []).filter((entry) => !getNameProblem(String(entry?.name ?? "")) && !getValueProblem(entry.name, String(entry?.value ?? "")));
	return Object.fromEntries(entries.slice(0, CUSTOM_HEADER_LIMITS.count).map(({ name, value }) => [name, value]));
}

// The settings form's text: one "Name: value" a line.
export function formatHeaderLines(headers) {
	return (headers ?? []).map(({ name, value }) => `${name}: ${value}`).join("\n");
}
