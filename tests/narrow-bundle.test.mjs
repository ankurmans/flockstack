import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { narrowFolder, narrowSource } from "../scripts/narrow-bundle.mjs";

// V8 keeps a script's source one byte per character unless one character is above U+00FF; the handler has a few hundred.
const run = (source) => new Function(`return (${source})`)();

test("writes characters above U+00FF as escapes that read back the same, in strings, regular expressions and templates", () => {
	const source = [
		'"it’s “quoted”…"',
		'/[.!?…]["\'”’)]*$/.test("done…")',
		'/[←-⇿]/u.test("→")',
		"`a→${1}b•`",
		'"a\\u2019"',
	].join(", ");
	const { narrowed, count } = narrowSource(`[${source}]`);
	assert.doesNotMatch(narrowed, /[^\x00-\xff]/u);
	assert.ok(count >= 8);
	assert.deepEqual(run(narrowed), run(`[${source}]`));
});

test("an escaped wide character keeps its meaning after a backslash, and astral characters become their pair", () => {
	assert.equal(run(narrowSource(String.raw`"\’"`).narrowed), "’");
	assert.equal(run(narrowSource(String.raw`"\\’"`).narrowed), "\\’");
	assert.equal(run(narrowSource('"😀"').narrowed), "😀");
	assert.equal(run(narrowSource("/😀/u").narrowed).test("😀"), true);
});

test("leaves ASCII and Latin-1 alone, and changes nothing on a second run", () => {
	const plain = `const a = "café ¡hola!" + 'x';`;
	assert.deepEqual(narrowSource(plain), { narrowed: plain, count: 0 });
	const once = narrowSource("const q = '’';").narrowed;
	assert.deepEqual(narrowSource(once), { narrowed: once, count: 0 });
});

test("narrows the handler files of a folder and skips the copies Wrangler never reads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "narrow-"));
	try {
		await mkdir(join(dir, "server-functions", "default", "node_modules"), { recursive: true });
		await mkdir(join(dir, "assets"), { recursive: true });
		await writeFile(join(dir, "server-functions", "default", "handler.mjs"), "export default '’';");
		await writeFile(join(dir, "server-functions", "default", "node_modules", "copy.js"), "module.exports = '’';");
		await writeFile(join(dir, "assets", "client.js"), "const a = '’';");
		assert.deepEqual(narrowFolder(dir), { files: 1, characters: 1 });
		assert.equal(await readFile(join(dir, "server-functions", "default", "handler.mjs"), "utf8"), "export default '\\u2019';");
		assert.equal(await readFile(join(dir, "server-functions", "default", "node_modules", "copy.js"), "utf8"), "module.exports = '’';");
		assert.equal(await readFile(join(dir, "assets", "client.js"), "utf8"), "const a = '’';");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("both Workers run it before Wrangler bundles", () => {
	const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
	for (const worker of [config, config.env.eu]) {
		assert.equal(worker.minify, true);
		assert.equal(worker.build.command, "node scripts/narrow-bundle.mjs");
	}
});
