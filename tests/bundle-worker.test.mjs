import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonc, squeeze } from "../scripts/bundle-worker.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
const esbuild = createRequire(join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js"))("esbuild");

test("takes out the whitespace and nothing else: the same code, no character above U+00FF", () => {
	const source = [
		"export function total(items) {",
		"\t// a comment",
		"\tlet sum = 0;",
		"\tfor (const item of items) {",
		"\t\tsum += item.price * item.count;",
		"\t}",
		"\treturn { sum, label: `Total: ${sum} …`, quote: '’', pattern: /[\\u201c\\u201d]/ };",
		"}",
	].join("\n");
	const squeezed = squeeze(source, esbuild);
	assert.ok(squeezed.length < source.length);
	assert.doesNotMatch(squeezed, /[^\x00-\xff]/u);
	assert.match(squeezed, /sum\+=item\.price\*item\.count/, "names and expressions are kept");
	const load = async (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	return Promise.all([load(source), load(squeezed)]).then(([plain, small]) => {
		const items = [{ price: 3, count: 2 }];
		assert.deepEqual(small.total(items), plain.total(items));
		assert.equal(small.total(items).pattern.test("“"), true);
	});
});

test("reads wrangler.jsonc, comments and all", () => {
	const config = readJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
	assert.equal(typeof config.compatibility_date, "string");
	assert.ok(config.compatibility_flags.includes("nodejs_compat"));
});
