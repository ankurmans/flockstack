import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findMissing, keepsName, planNames, rewrite, shortenChunkNames } from "../scripts/short-chunk-names.mjs";

// scripts/short-chunk-names.mjs: every server chunk gets a name of a few characters, and every file of the build that names a chunk (the
// loaders' lists, the routes' entries, the client reference manifests, the trace files, a duplicate's stub, a source map's address) names
// the new one. The runtime and the [externals] chunks, which OpenNext finds by name, keep theirs.
let dist;
let standalone;
const require = createRequire(import.meta.url);
const LONG = "lib_account-assistant_12dgega1l6364.js";
const SSR = "[root-of-the-server]__0bd2z2kxlvy87._.js";
const PARENS = "app_(app)_campaigns_page_0x1y2z3a4b5c6._.js";

function writeBuild(root) {
	const chunks = join(root, "server", "chunks");
	mkdirSync(join(chunks, "ssr"), { recursive: true });
	mkdirSync(join(root, "server", "app", "(app)", "campaigns"), { recursive: true });
	writeFileSync(join(chunks, LONG), `module.exports=[1,e=>{e.v({marker:"long"})}];\n//# sourceMappingURL=${LONG}.map`);
	writeFileSync(join(chunks, `${LONG}.map`), '{"version":3,"sources":[],"mappings":""}');
	writeFileSync(join(chunks, "ssr", SSR), `module.exports=[2,s=>{s.v(e=>Promise.all(["server/chunks/${LONG}","server/chunks/ssr/${PARENS}"].map(e=>s.l(e))))}];`);
	writeFileSync(join(chunks, "ssr", PARENS), `module.exports=require("../${LONG}");\n`);
	writeFileSync(join(chunks, "[turbopack]_runtime.js"), 'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";');
	writeFileSync(join(chunks, "ssr", "[turbopack]_runtime.js"), 'var RUNTIME_PUBLIC_PATH = "server/chunks/ssr/[turbopack]_runtime.js";');
	writeFileSync(join(chunks, "[externals]_node_fs_1t1l-4-zroh_0._.js"), "module.exports=[3,e=>{}];");
	writeFileSync(join(chunks, "ssr", "[externals]_node_fs_1t1l-4-zroh_0._.js"), "module.exports=[3,e=>{}];");
	const page = join(root, "server", "app", "(app)", "campaigns");
	writeFileSync(join(page, "page.js"), `var R=require("../../../chunks/ssr/[turbopack]_runtime.js")("server/app/(app)/campaigns/page.js")\nR.c("server/chunks/ssr/${SSR}")\nR.c("server/chunks/[externals]_node_fs_1t1l-4-zroh_0._.js")\n`);
	writeFileSync(join(page, "page.js.nft.json"), JSON.stringify({ version: 1, files: ["../../../chunks/ssr/[turbopack]_runtime.js", `../../../chunks/ssr/${SSR}`, `../../../chunks/${LONG}`, "../../../../package.json"] }));
	writeFileSync(join(page, "page_client-reference-manifest.js"), `globalThis.__RSC_MANIFEST={"ssrModuleMapping":{"1":{"*":{"chunks":["server/chunks/ssr/${PARENS}"]}}},"clientModules":{"x":{"chunks":["static/chunks/${LONG}"]}}};`);
}

before(() => {
	dist = mkdtempSync(join(tmpdir(), "flockstack-short-chunks-"));
	standalone = join(dist, "standalone", ".next");
	writeBuild(dist);
	writeBuild(standalone);
});

after(() => rmSync(dist, { recursive: true, force: true }));

describe("short-chunk-names", () => {
	test("the runtime, the [externals] chunks and names already short keep their names; a name in two folders keeps it too", () => {
		assert.equal(keepsName("[turbopack]_runtime.js"), true);
		assert.equal(keepsName("[externals]_node_fs_1t1l-4-zroh_0._.js"), true);
		assert.equal(keepsName("2kf.js"), true);
		assert.equal(keepsName(LONG), false);
		const names = planNames([join(dist, "server", "chunks")]);
		assert.deepEqual([...names.keys()].sort(), [LONG, PARENS, SSR].sort());
		assert.ok([...names.values()].every((name) => /^[0-9a-z]{1,4}\.js$/.test(name)));
		assert.equal(new Set(names.values()).size, names.size, "no two chunks share a name");
		const twice = mkdtempSync(join(tmpdir(), "flockstack-short-chunks-twice-"));
		try {
			mkdirSync(join(twice, "ssr"));
			for (const folder of [twice, join(twice, "ssr")]) writeFileSync(join(folder, "lib_both_0abc._.js"), "module.exports=[];");
			assert.deepEqual([...planNames([twice]).keys()], []);
		} finally {
			rmSync(twice, { recursive: true, force: true });
		}
	});

	test("a name is replaced where it is a whole name, and only then", () => {
		const names = new Map([[LONG, "0.js"]]);
		assert.equal(rewrite(`"server/chunks/${LONG}"`, names), '"server/chunks/0.js"');
		assert.equal(rewrite(`sourceMappingURL=${LONG}.map`, names), "sourceMappingURL=0.js.map");
		assert.equal(rewrite(`require("./${LONG}")`, names), 'require("./0.js")');
		assert.equal(rewrite(`"server/chunks/x${LONG}"`, names), `"server/chunks/x${LONG}"`, "a longer name is another chunk");
		assert.equal(rewrite(`"server/chunks/${LONG}x"`, names), `"server/chunks/${LONG}x"`);
	});

	test("renames the chunks of both builds the same way and every file that names them, and nothing names a chunk that is not there", () => {
		const results = shortenChunkNames([dist, standalone]);
		assert.deepEqual(
			results.map(({ renamed }) => renamed),
			[3, 3]
		);
		assert.ok(results.every(({ saved }) => saved > 100));
		const map = JSON.parse(readFileSync(join(dist, "chunk-names.json"), "utf8"));
		const short = Object.fromEntries(Object.entries(map).map(([name, old]) => [old, name]));
		for (const root of [dist, standalone]) {
			const chunks = join(root, "server", "chunks");
			assert.ok(!existsSync(join(chunks, LONG)) && existsSync(join(chunks, short[LONG])));
			assert.ok(existsSync(join(chunks, `${short[LONG]}.map`)), "the source map follows its chunk");
			assert.match(readFileSync(join(chunks, short[LONG]), "utf8"), new RegExp(`sourceMappingURL=${short[LONG]}\\.map$`));
			assert.ok(existsSync(join(chunks, "[turbopack]_runtime.js")) && existsSync(join(chunks, "ssr", "[externals]_node_fs_1t1l-4-zroh_0._.js")));
			const page = join(root, "server", "app", "(app)", "campaigns");
			assert.equal(readFileSync(join(page, "page.js"), "utf8").includes(`R.c("server/chunks/ssr/${short[SSR]}")`), true);
			assert.ok(JSON.parse(readFileSync(join(page, "page.js.nft.json"), "utf8")).files.includes(`../../../chunks/${short[LONG]}`));
			const manifest = readFileSync(join(page, "page_client-reference-manifest.js"), "utf8");
			assert.ok(manifest.includes(`"server/chunks/ssr/${short[PARENS]}"`));
			assert.ok(manifest.includes(`"static/chunks/${short[LONG]}"`) === false, "a client chunk is the browser's file, not a server chunk");
			assert.deepEqual(findMissing(root), []);
			for (const name of readdirSync(chunks)) assert.ok(!name.includes("account-assistant"), name);
		}
	});

	test("a renamed stub still loads what it pointed at, and a second run changes nothing", () => {
		const chunks = join(dist, "server", "chunks");
		const stub = readdirSync(join(chunks, "ssr")).find((name) => readFileSync(join(chunks, "ssr", name), "utf8").startsWith("module.exports=require("));
		assert.equal(require(join(chunks, "ssr", stub)), require(join(chunks, readdirSync(chunks).find((name) => /^[0-9a-z]+\.js$/.test(name)))));
		const before = readFileSync(join(dist, "server", "app", "(app)", "campaigns", "page.js"), "utf8");
		assert.deepEqual(
			shortenChunkNames([dist]).map(({ renamed, files }) => [renamed, files]),
			[[0, 0]]
		);
		assert.equal(readFileSync(join(dist, "server", "app", "(app)", "campaigns", "page.js"), "utf8"), before);
	});

	test("stops the build when a file names a chunk that is not there", () => {
		const broken = mkdtempSync(join(tmpdir(), "flockstack-short-chunks-broken-"));
		try {
			mkdirSync(join(broken, "server", "chunks"), { recursive: true });
			writeFileSync(join(broken, "server", "middleware.js"), 'R.c("server/chunks/gone_0abc._.js")');
			assert.throws(() => shortenChunkNames([broken]), /names chunks that are not there: server\/chunks\/gone_0abc\._\.js/);
		} finally {
			rmSync(broken, { recursive: true, force: true });
		}
	});
});
