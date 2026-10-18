// Column names the CSV import recognizes, so an export goes back in as it is.
export const CSV_COLUMNS = [
	["email", (contact) => contact.email],
	["status", (contact) => contact.status],
	["newsletter", (contact, newsletters) => newsletters.get(String(contact.newsletterId)) ?? ""],
	["source", (contact) => contact.source ?? ""],
	["subscribed_at", (contact) => contact.subscribedAt],
	["confirmed_at", (contact) => contact.confirmedAt],
	["unsubscribed_at", (contact) => contact.unsubscribedAt],
	["last_sent_at", (contact) => contact.lastSentAt],
	["last_open_at", (contact) => contact.lastOpenAt],
	["last_click_at", (contact) => contact.lastClickAt],
	["emails_received", (contact) => contact.stats?.sent ?? 0],
	["opens", (contact) => contact.stats?.opens ?? 0],
	["clicks", (contact) => contact.stats?.clicks ?? 0],
];

// What the full account export adds: tags where contacts have them (a list, written as a;b), and the referral program's
// counts. The import skips columns it doesn't know.
export const EXPORT_COLUMNS = [
	...CSV_COLUMNS,
	["tags", (contact) => (Array.isArray(contact.tags) ? contact.tags.join(";") : "")],
	["referrals", (contact) => contact.referral?.count ?? 0],
	["referred_by", (contact) => contact.referral?.referredBy ?? ""],
	["created_at", (contact) => contact.createdAt],
];

// Spreadsheets run a cell starting with = + - @ (or a tab or return) as a formula; a leading quote
// keeps it text. An address can begin that way too (the dot-atom syntax allows =, + and -), and
// =cmd|'…'!A1 needs no parentheses, so emails get the quote as well: a real one never starts with
// those, and an address that does is treated as text on the way back in.
export function toCell(value) {
	if (value === undefined || value === null) return "";
	const text = value instanceof Date ? value.toISOString() : String(value);
	const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
	return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function getCsvHeader(columns = CSV_COLUMNS) {
	return `${columns.map(([name]) => name).join(",")}\r\n`;
}

// newsletters: newsletter ID to slug.
export function toCsvRow(contact, newsletters = new Map(), columns = CSV_COLUMNS) {
	return `${columns.map(([, read]) => toCell(read(contact, newsletters))).join(",")}\r\n`;
}
