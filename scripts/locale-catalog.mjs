// What export-locale-catalog.mjs and import-locale-catalog.mjs share: the reader catalog (lib/reader-language-copy.js), the CSV a reviewer edits, and the
// rules a revised phrase must keep. The English phrase of a row is its key; a revision may change a translation and never a key or a placeholder.
import { pathToFileURL } from "node:url";

export const DEFAULT_CATALOG = new URL("../lib/reader-language-copy.js", import.meta.url).pathname;
export const COLUMNS = ["locale", "key", "current", "revised", "placeholders", "note"];
// The one form the app reads: lowercase letters in braces, as lib/reader-languages.js replaces them.
export const PLACEHOLDER = /\{[a-z]+\}/g;

export async function loadCatalog(path = DEFAULT_CATALOG) {
	const { READER_COPY, READER_LANGUAGES } = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
	return { copy: READER_COPY, languages: READER_LANGUAGES };
}

export const placeholdersOf = (text) => [...String(text).matchAll(PLACEHOLDER)].map(([token]) => token).sort();

function quote(value) {
	const text = String(value ?? "");
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows) {
	return `﻿${rows.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

// RFC 4180: quoted fields hold commas, quotes (doubled) and line breaks. A byte order mark and either line ending are accepted.
export function parseCsv(text) {
	const source = text.replace(/^﻿/, "");
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;
	let seen = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (inQuotes) {
			if (char === '"' && source[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') inQuotes = false;
			else field += char;
		} else if (char === '"' && field === "") {
			inQuotes = true;
			seen = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
			seen = true;
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && source[index + 1] === "\n") index++;
			if (seen || field !== "") {
				row.push(field);
				rows.push(row);
			}
			row = [];
			field = "";
			seen = false;
		} else field += char;
	}
	if (inQuotes) throw new Error("A quoted field is never closed");
	if (seen || field !== "") {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

export function exportRows(copy, locale) {
	const rows = [COLUMNS];
	for (const [key, current] of Object.entries(copy[locale])) {
		const note = locale !== "en" && current === key ? "same as English: check that it should be" : "";
		rows.push([locale, key, current, "", placeholdersOf(key).join(" "), note]);
	}
	return rows;
}
