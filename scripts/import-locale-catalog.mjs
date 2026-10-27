// Checks a reviewer's CSV (scripts/export-locale-catalog.mjs) against the reader catalog and, with --write, puts the revised phrases into
// lib/reader-language-copy.js. Without --write nothing is changed: it reports what would be.
//   node scripts/import-locale-catalog.mjs reader-catalog-fr.csv [--locale fr] [--write]
// A revision fails when it drops, adds or renames a {placeholder}, has a stray brace, a line break or markup the English phrase does not
// have, changes a key (the English phrase) or starts from a catalog that has changed since the export. Only the `revised` column is read
// for changes: an empty one, or one equal to `current`, keeps the phrase. Exits 1 when a row fails, 2 when it is used wrongly.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { COLUMNS, DEFAULT_CATALOG, PLACEHOLDER, loadCatalog, parseCsv, placeholdersOf } from "./locale-catalog.mjs";

// Rows of lib/reader-language-copy.js are one array each, on a line of their own: the English phrase first, then es, fr, de, it, pt.
const ROW = /^\t(\[.*\])(,?)$/;

export async function checkImport(csvText, { locale = null, catalog = DEFAULT_CATALOG, allowStale = false } = {}) {
	const { copy, languages } = await loadCatalog(catalog);
	const errors = [];
	const warnings = [];
	const changes = [];
	let rows;
	try {
		rows = parseCsv(csvText);
	} catch (error) {
		return { errors: [error.message], warnings, changes, locale };
	}
	const header = rows.shift() ?? [];
	const missing = COLUMNS.filter((column) => ["locale", "key", "current", "revised"].includes(column) && !header.includes(column));
	if (missing.length > 0) return { errors: [`The header lacks ${missing.join(", ")}: ${header.join(",")}`], warnings, changes, locale };
	const at = Object.fromEntries(header.map((name, index) => [name, index]));
	const seen = new Set();
	const fileLocales = new Set(rows.map((row) => row[at.locale]?.trim()).filter(Boolean));
	if (fileLocales.size > 1) errors.push(`The file mixes languages: ${[...fileLocales].join(", ")}`);
	locale ??= [...fileLocales][0] ?? null;
	if (!locale || !languages.includes(locale)) return { errors: [...errors, `The language ${JSON.stringify(locale)} is not one of ${languages.join(", ")}`], warnings, changes, locale };
	if (locale === "en") return { errors: [...errors, "English phrases are the keys: they are not revised here"], warnings, changes, locale };
	if (fileLocales.size > 0 && !fileLocales.has(locale)) errors.push(`The file is for ${[...fileLocales].join(", ")}, not ${locale}`);
	const usesCurly = Object.values(copy[locale]).some((text) => text.includes("’"));

	rows.forEach((row, index) => {
		const line = index + 2;
		const fail = (message) => errors.push(`row ${line}: ${message}`);
		const key = row[at.key];
		if (row.length === 1 && row[0].trim() === "") return;
		if (row.length < header.length) return fail(`${row.length} columns, the header has ${header.length}`);
		const where = `"${String(key).slice(0, 60)}"`;
		if (!(key in copy.en)) return fail(`${where} is not a key of the catalog (the key column is the English phrase and must not be edited)`);
		if (seen.has(key)) return fail(`${where} appears twice`);
		seen.add(key);
		const stored = copy[locale][key];
		if (row[at.current] !== stored && !allowStale) fail(`${where}: the current text is not the catalog's any more (export again, or use --allow-stale)`);
		let revised = row[at.revised];
		if (revised == null || revised.trim() === "") return;
		const normalized = revised.normalize("NFC").trim();
		if (normalized !== revised) warnings.push(`row ${line}: ${where}: spaces at the ends or accents in decomposed form were tidied`);
		revised = normalized;
		if (revised === stored) return;
		if (/[\r\n\t\u0000-\u001f]/.test(revised)) return fail(`${where}: has a line break, tab or control character`);
		const want = placeholdersOf(key);
		const got = placeholdersOf(revised);
		if (want.join(" ") !== got.join(" ")) return fail(`${where}: placeholders are ${got.join(" ") || "none"}, the English has ${want.join(" ") || "none"}`);
		if (revised.replace(PLACEHOLDER, "").match(/[{}]/)) return fail(`${where}: a stray brace (only {lowercase} placeholders are read)`);
		if (/<[^>]*>/.test(revised) && !/<[^>]*>/.test(key)) return fail(`${where}: has markup the English phrase does not have`);
		if (revised.length > key.length * 3 + 30) warnings.push(`row ${line}: ${where}: ${revised.length} characters against ${key.length} in English: check it fits`);
		if (usesCurly && revised.includes("'")) warnings.push(`row ${line}: ${where}: a straight apostrophe, the catalog writes ’`);
		changes.push({ key, from: stored, to: revised });
	});
	return { errors, warnings, changes, locale, rows: rows.length };
}

// The catalog's source with the revisions in it: only the lines of the changed phrases are rewritten, every other byte stays.
export function applyChanges(source, locale, languages, changes) {
	const column = languages.indexOf(locale);
	const byKey = new Map(changes.map((change) => [change.key, change.to]));
	let applied = 0;
	const lines = source.split("\n").map((line) => {
		const match = ROW.exec(line);
		if (!match) return line;
		let row;
		try {
			row = JSON.parse(match[1]);
		} catch {
			return line;
		}
		if (!byKey.has(row[0])) return line;
		row[column] = byKey.get(row[0]);
		applied++;
		return `\t[${row.map((value) => JSON.stringify(value)).join(", ")}]${match[2]}`;
	});
	return { source: lines.join("\n"), applied };
}

async function loadSource(source) {
	return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

export async function writeChanges(csvText, options = {}) {
	const result = await checkImport(csvText, options);
	if (result.errors.length > 0 || result.changes.length === 0) return { ...result, written: 0 };
	const path = options.catalog ?? DEFAULT_CATALOG;
	const { languages, copy } = await loadCatalog(path);
	const { source, applied } = applyChanges(readFileSync(path, "utf8"), result.locale, languages, result.changes);
	if (applied < result.changes.length) return { ...result, errors: [`Only ${applied} of ${result.changes.length} phrases were found as rows of ${path}`], written: 0 };
	// What would be written must load, and be the old catalog with exactly these phrases changed.
	const next = (await loadSource(source)).READER_COPY;
	const changed = new Map(result.changes.map(({ key, to }) => [key, to]));
	for (const language of languages) {
		for (const key of Object.keys(copy.en)) {
			const expected = language === result.locale && changed.has(key) ? changed.get(key) : copy[language][key];
			if (next[language]?.[key] !== expected) return { ...result, errors: [`The rewritten catalog differs from the plan at ${language} ${JSON.stringify(key)}: nothing was written`], written: 0 };
		}
		if (Object.keys(next[language]).length !== Object.keys(copy[language]).length) return { ...result, errors: ["The rewritten catalog has another number of phrases: nothing was written"], written: 0 };
	}
	writeFileSync(path, source);
	return { ...result, written: result.changes.length };
}

async function main(argv) {
	const args = argv.slice();
	const take = (flag) => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		return args.splice(index, 2)[1] ?? "";
	};
	const locale = take("--locale");
	const catalog = take("--catalog") ?? DEFAULT_CATALOG;
	const write = args.includes("--write");
	const allowStale = args.includes("--allow-stale");
	const files = args.filter((argument) => !argument.startsWith("--"));
	if (files.length !== 1 || args.some((argument) => argument.startsWith("--") && !["--write", "--allow-stale"].includes(argument))) {
		console.error("usage: node scripts/import-locale-catalog.mjs <file.csv> [--locale fr] [--write] [--allow-stale]");
		return 2;
	}
	let text;
	try {
		text = readFileSync(files[0], "utf8");
	} catch {
		console.error(`Cannot read ${files[0]}`);
		return 2;
	}
	const result = await (write ? writeChanges : checkImport)(text, { locale, catalog, allowStale });
	for (const warning of result.warnings) console.log(`warning  ${warning}`);
	for (const error of result.errors) console.log(`FAIL     ${error}`);
	if (result.errors.length > 0) {
		console.log(`${result.errors.length} problems. Nothing was changed.`);
		return 1;
	}
	console.log(`${result.locale}: ${result.changes.length} revised phrases of ${result.rows}.${write ? (result.written ? ` Written to ${catalog}.` : " Nothing to write.") : result.changes.length ? " Run again with --write to apply them." : ""}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
