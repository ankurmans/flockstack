import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportLocale } from "../scripts/export-locale-catalog.mjs";
import { applyChanges, checkImport, writeChanges } from "../scripts/import-locale-catalog.mjs";
import { DEFAULT_CATALOG, COLUMNS, loadCatalog, parseCsv, placeholdersOf, toCsv } from "../scripts/locale-catalog.mjs";
import { READER_COPY, READER_LANGUAGES } from "../lib/reader-language-copy.js";

// The export and import of the reader catalog for a native reviewer (docs/RELEASE-QA.md): the CSV round trip, each rule a revised phrase
// must keep, and a write onto a copy of the catalog that leaves everything else as it was.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
let dir;
let catalog;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "locale-catalog-"));
	catalog = join(dir, "reader-language-copy.js");
	copyFileSync(DEFAULT_CATALOG, catalog);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// The export of a language with some `revised` cells filled in: { "English phrase": "revision" }.
async function reviewed(locale, revisions) {
	const rows = parseCsv(await exportLocale(locale, { catalog }));
	for (const row of rows.slice(1)) if (row[1] in revisions) row[3] = revisions[row[1]];
	return toCsv(rows);
}

describe("the CSV", () => {
	test("keeps commas, quotes, line breaks and accents through a write and a read", () => {
		const rows = [["a,b", 'say "hi"', "two\nlines", "crlf\r\nline", "café ’ 日本", "", " padded "]];
		assert.deepEqual(parseCsv(toCsv(rows)), rows);
		assert.ok(toCsv(rows).startsWith("﻿"));
		assert.deepEqual(parseCsv("a,b\r\n1,2"), [["a", "b"], ["1", "2"]]);
		assert.deepEqual(parseCsv("a,b\n\n1,\"\"\n"), [["a", "b"], ["1", ""]]);
		assert.throws(() => parseCsv('a,"b'), /never closed/);
	});

	test("an export of every language lists every key once, with the current text and the placeholders", async () => {
		const keys = Object.keys(READER_COPY.en);
		for (const language of READER_LANGUAGES) {
			const rows = parseCsv(await exportLocale(language, { catalog }));
			assert.deepEqual(rows[0], COLUMNS);
			assert.equal(rows.length - 1, keys.length);
			assert.deepEqual(rows.slice(1).map((row) => row[1]), keys);
			assert.ok(rows.slice(1).every((row) => row[0] === language && row[2] === READER_COPY[language][row[1]] && row[3] === "" && row[4] === placeholdersOf(row[1]).join(" ")));
		}
		const months = parseCsv(await exportLocale("de", { catalog })).find((row) => row[1] === "{months} months");
		assert.equal(months[4], "{months}");
		await assert.rejects(exportLocale("xx", { catalog }), /not one of/);
	});

	test("an untouched export changes nothing, and a revision to a different phrase is a change", async () => {
		const untouched = await checkImport(await exportLocale("fr", { catalog }), { catalog });
		assert.deepEqual([untouched.errors, untouched.changes], [[], []]);
		const result = await checkImport(await reviewed("fr", { "Unpaid": "Non payé", "Price": "Prix" }), { catalog });
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.changes, [{ key: "Unpaid", from: "Impayé", to: "Non payé" }], "a revision equal to the current phrase is no change");
	});
});

describe("what a revision must keep", () => {
	const KEY = "{months} months";
	const problems = async (revised, locale = "es", key = KEY) => (await checkImport(await reviewed(locale, { [key]: revised }), { catalog })).errors;

	test("a dropped, added, renamed or repeated placeholder fails", async () => {
		assert.match((await problems("meses"))[0], /placeholders are none, the English has \{months\}/);
		assert.match((await problems("{months} {days} meses"))[0], /placeholders are \{days\} \{months\}/);
		assert.match((await problems("{month} meses"))[0], /placeholders are \{month\}/);
		assert.match((await problems("{months} {months} meses"))[0], /placeholders are \{months\} \{months\}/);
		assert.deepEqual(await problems("{months} meses seguidos"), []);
		const two = Object.keys(READER_COPY.en).find((key) => placeholdersOf(key).length === 2);
		const [first, second] = placeholdersOf(two);
		assert.deepEqual(await problems(`${second} / ${first}`, "fr", two), [], "the order is the translator's");
		assert.match((await problems(first, "fr", two))[0], /placeholders/);
	});

	test("stray braces, other placeholder forms, markup and line breaks fail", async () => {
		assert.match((await problems("{months} meses {"))[0], /stray brace/);
		assert.match((await problems("{months} meses }"))[0], /stray brace/);
		assert.match((await problems("{Months} meses"))[0], /placeholders are none/);
		assert.match((await problems("{months} meses <b>x</b>"))[0], /markup/);
		assert.match((await problems("{months}\nmeses"))[0], /line break/);
		assert.match((await problems("{months}\u0007 meses"))[0], /control character/);
	});

	test("a changed key, an unknown key, a repeated row, a stale current text and a wrong language fail", async () => {
		const rows = parseCsv(await exportLocale("it", { catalog }));
		const withRow = (edit) => {
			const copy = rows.map((row) => [...row]);
			edit(copy);
			return toCsv(copy);
		};
		const renamed = await checkImport(withRow((copy) => { copy[1][1] = "Subscription actve"; copy[1][3] = "Attiva"; }), { catalog });
		assert.match(renamed.errors[0], /not a key of the catalog/);
		const twice = await checkImport(withRow((copy) => copy.push([...copy[1]])), { catalog });
		assert.match(twice.errors[0], /appears twice/);
		const stale = await checkImport(withRow((copy) => { copy[1][2] = "Old text"; copy[1][3] = "Nuovo"; }), { catalog });
		assert.match(stale.errors[0], /current text is not the catalog's/);
		assert.deepEqual((await checkImport(withRow((copy) => { copy[1][2] = "Old text"; copy[1][3] = "Nuovo"; }), { catalog, allowStale: true })).errors, []);
		const wrong = await checkImport(await exportLocale("it", { catalog }), { catalog, locale: "fr" });
		assert.match(wrong.errors[0], /for it, not fr/);
		assert.match((await checkImport(await exportLocale("en", { catalog }), { catalog })).errors[0], /English phrases are the keys/);
		assert.match((await checkImport("key,current\r\nx,y\r\n", { catalog })).errors[0], /header lacks locale, revised/);
		assert.match((await checkImport("locale,key,current,revised\r\nxx,Price,a,b\r\n", { catalog })).errors[0], /not one of/);
		assert.match((await checkImport('locale,key,current,revised\r\nes,"Price,a,b\r\n', { catalog })).errors[0], /never closed/);
		const mixed = await checkImport(withRow((copy) => { copy[2][0] = "fr"; }), { catalog });
		assert.match(mixed.errors[0], /mixes languages/);
	});

	test("tidies spaces and decomposed accents with a warning, and warns about long phrases and straight apostrophes", async () => {
		const result = await checkImport(await reviewed("fr", { "Price": "  Tarif  ", "Content": "Café ".repeat(1) , "Other": "Autre chose qu'on" }), { catalog });
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.changes.map(({ to }) => to), ["Tarif", "Café", "Autre chose qu'on"]);
		assert.ok(result.warnings.some((warning) => /tidied/.test(warning)));
		assert.ok(result.warnings.some((warning) => /straight apostrophe/.test(warning)));
		const long = await checkImport(await reviewed("fr", { "Price": "x".repeat(200) }), { catalog });
		assert.ok(long.warnings.some((warning) => /200 characters against 5/.test(warning)));
	});
});

describe("writing the revisions", () => {
	test("rewrites only the revised rows of a copy of the catalog and the result loads with nothing else changed", async () => {
		const before = readFileSync(catalog, "utf8");
		const revisions = { "Unpaid": "Non payé", "{months} months": "{months} mois au total", "Sponsor this newsletter": "Sponsoriser cette lettre" };
		const result = await writeChanges(await reviewed("fr", revisions), { catalog });
		assert.deepEqual(result.errors, []);
		assert.equal(result.written, 3);
		const after = readFileSync(catalog, "utf8");
		const beforeLines = before.split("\n");
		const afterLines = after.split("\n");
		assert.equal(afterLines.length, beforeLines.length);
		assert.equal(afterLines.filter((line, index) => line !== beforeLines[index]).length, 3, "three lines changed");
		const loaded = await loadCatalog(catalog);
		for (const language of READER_LANGUAGES) {
			for (const key of Object.keys(READER_COPY.en)) {
				const expected = language === "fr" && key in revisions ? revisions[key] : READER_COPY[language][key];
				assert.equal(loaded.copy[language][key], expected, `${language} ${key}`);
			}
		}
		assert.ok(after.endsWith(before.slice(before.indexOf("export const READER_LANGUAGES"))), "the code after the rows is untouched");
		assert.equal((await checkImport(await exportLocale("fr", { catalog }), { catalog })).changes.length, 0);
		copyFileSync(DEFAULT_CATALOG, catalog);
	});

	test("writes nothing when any row fails, and nothing when there is nothing to change", async () => {
		const before = readFileSync(catalog, "utf8");
		const bad = await writeChanges(await reviewed("de", { "Unpaid": "Unbezahlt!", "{months} months": "Monate" }), { catalog });
		assert.equal(bad.written, 0);
		assert.equal(bad.errors.length, 1);
		assert.equal(readFileSync(catalog, "utf8"), before);
		const none = await writeChanges(await exportLocale("de", { catalog }), { catalog });
		assert.deepEqual([none.written, none.errors], [0, []]);
		assert.equal(readFileSync(catalog, "utf8"), before);
	});

	test("changes every row of a repeated key, keeps a last row without a comma, and is refused if a row cannot be found", async () => {
		const source = 'const PHRASES = [\n\t["A", "a-es", "a-fr", "a-de", "a-it", "a-pt"],\n\t["A", "a-es", "a-fr", "a-de", "a-it", "a-pt"],\n\t["B {n}", "b-es", "b-fr", "b-de", "b-it", "b-pt"]\n];\n';
		const { source: next, applied } = applyChanges(source, "de", ["en", "es", "fr", "de", "it", "pt"], [{ key: "A", to: "neu \"quoted\"" }, { key: "B {n}", to: "b {n} neu" }]);
		assert.equal(applied, 3);
		assert.match(next, /\t\["A", "a-es", "a-fr", "neu \\"quoted\\"", "a-it", "a-pt"\],\n\t\["A"/);
		assert.match(next, /\t\["B \{n\}", "b-es", "b-fr", "b \{n\} neu", "b-it", "b-pt"\]\n\];/);
		assert.equal(applyChanges(source, "de", ["en", "es", "fr", "de", "it", "pt"], [{ key: "C", to: "x" }]).applied, 0);
	});
});

describe("the commands", () => {
	const run = (script, args) => spawnSync("node", [`scripts/${script}`, ...args], { cwd: ROOT, encoding: "utf8" });

	test("export writes the file or all six files, and refuses wrong use with exit 2", () => {
		const file = join(dir, "fr.csv");
		const one = run("export-locale-catalog.mjs", ["--locale", "fr", "--out", file, "--catalog", catalog]);
		assert.equal(one.status, 0, one.stderr);
		assert.match(one.stdout, new RegExp(`${Object.keys(READER_COPY.en).length} phrases \\(fr\\)`));
		assert.equal(parseCsv(readFileSync(file, "utf8")).length, Object.keys(READER_COPY.en).length + 1);
		const all = run("export-locale-catalog.mjs", ["--all", "--out-dir", join(dir, "all"), "--catalog", catalog]);
		assert.equal(all.status, 0, all.stderr);
		assert.equal(all.stdout.trim().split("\n").length, 5, "every language but English");
		for (const args of [[], ["--locale", "xx"], ["--locale", "fr", "--all"], ["--all", "--out", "x.csv"], ["--locale", "fr", "--out-dir", "x"]]) assert.equal(run("export-locale-catalog.mjs", args).status, 2, args.join(" "));
	});

	test("import checks by default, exits 1 on a failure and 0 on a pass, writes only with --write", async () => {
		const file = join(dir, "review.csv");
		writeFileSync(file, await reviewed("pt", { "Unpaid": "Por pagar" }));
		const same = run("import-locale-catalog.mjs", [file, "--catalog", catalog]);
		assert.equal(same.status, 0, same.stdout);
		writeFileSync(file, await reviewed("pt", { "Unpaid": "Em falta" }));
		const check = run("import-locale-catalog.mjs", [file, "--catalog", catalog]);
		assert.equal(check.status, 0);
		assert.match(check.stdout, new RegExp(`pt: 1 revised phrases of ${Object.keys(READER_COPY.en).length}\\. Run again with --write`));
		assert.match(readFileSync(catalog, "utf8"), /"Por pagar"/);
		const written = run("import-locale-catalog.mjs", [file, "--catalog", catalog, "--write"]);
		assert.equal(written.status, 0, written.stdout);
		assert.match(readFileSync(catalog, "utf8"), /"Em falta"/);
		writeFileSync(file, await reviewed("pt", { "{months} months": "meses" }));
		const failed = run("import-locale-catalog.mjs", [file, "--catalog", catalog]);
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /FAIL .*placeholders are none/);
		assert.match(failed.stdout, /Nothing was changed/);
		for (const args of [[], [file, "--bogus"], [join(dir, "missing.csv")]]) assert.equal(run("import-locale-catalog.mjs", args).status, 2, args.join(" "));
		copyFileSync(DEFAULT_CATALOG, catalog);
	});

	test("the real catalog is the one the scripts default to, and none of the tests changed it", () => {
		assert.ok(DEFAULT_CATALOG.endsWith("/lib/reader-language-copy.js"));
		assert.doesNotMatch(readFileSync(DEFAULT_CATALOG, "utf8"), /Em falta|Non payé|mois au total/);
	});
});
