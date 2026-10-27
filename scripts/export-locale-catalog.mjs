// Writes one language of the reader catalog (lib/reader-language-copy.js) as a CSV a native reviewer edits in any spreadsheet.
//   node scripts/export-locale-catalog.mjs --locale fr [--out reader-catalog-fr.csv]
//   node scripts/export-locale-catalog.mjs --all [--out-dir some/folder]
// Columns: locale, key (the English phrase: never edit it), current (what the app says now), revised (the reviewer fills in only the phrases
// to change; empty keeps the current one), placeholders (the {words} the phrase must keep, any order), note.
// The file is UTF-8 with a byte order mark so Excel reads the accents. scripts/import-locale-catalog.mjs checks it and applies it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CATALOG, exportRows, loadCatalog, toCsv } from "./locale-catalog.mjs";

export async function exportLocale(locale, { catalog = DEFAULT_CATALOG } = {}) {
	const { copy, languages } = await loadCatalog(catalog);
	if (!languages.includes(locale)) throw new Error(`${locale} is not one of ${languages.join(", ")}`);
	return toCsv(exportRows(copy, locale));
}

async function main(argv) {
	const args = argv.slice();
	const take = (flag) => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		return args.splice(index, 2)[1] ?? "";
	};
	const locale = take("--locale");
	const out = take("--out");
	const outDir = take("--out-dir");
	const all = args.includes("--all");
	const catalog = take("--catalog") ?? DEFAULT_CATALOG;
	const usage = "usage: node scripts/export-locale-catalog.mjs --locale <es|fr|de|it|pt|en> [--out file.csv]   or   --all [--out-dir folder]";
	if ((!locale && !all) || (locale && all) || args.some((argument) => argument !== "--all")) {
		console.error(usage);
		return 2;
	}
	const { languages } = await loadCatalog(catalog);
	const targets = all ? languages.filter((language) => language !== "en") : [locale];
	if (targets.some((language) => !languages.includes(language))) {
		console.error(`${locale} is not one of ${languages.join(", ")}\n${usage}`);
		return 2;
	}
	if (all && out) {
		console.error(`--all writes one file per language: use --out-dir\n${usage}`);
		return 2;
	}
	if (!all && outDir) {
		console.error(`--out-dir is for --all: use --out\n${usage}`);
		return 2;
	}
	if (outDir) mkdirSync(outDir, { recursive: true });
	for (const language of targets) {
		const csv = await exportLocale(language, { catalog });
		const file = all ? join(outDir ?? ".", `reader-catalog-${language}.csv`) : out;
		if (file) {
			writeFileSync(file, csv);
			console.log(`${file}: ${csv.split("\r\n").length - 2} phrases (${language})`);
		} else process.stdout.write(csv);
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
