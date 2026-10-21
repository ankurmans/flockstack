import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { dedupeFolder, toStub } from "../scripts/dedupe-chunks.mjs";

// scripts/dedupe-chunks.mjs: Turbopack writes a chunk once per chunk group under another name, and only the source map's address
// differs. The copies become a line that loads the first, and the module lists they hand to the loader stay what they were.
let folder;
const require = createRequire(import.meta.url);
const big = (marker) => `module.exports=[123,(e,t,r)=>{"use strict";t.exports={marker:${JSON.stringify(marker)},pad:${JSON.stringify("x".repeat(3000))}}}];`;
const hoisted = (marker) => `(()=>{"use strict";module.exports=[456,a=>{a.s({marker:${JSON.stringify(marker)}})},"${"y".repeat(3000)}"]})();`;

before(() => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-chunks-"));
	mkdirSync(join(folder, "ssr"));
	writeFileSync(join(folder, "a.js"), `${big("one")}\n\n//# sourceMappingURL=a.js.map`);
	writeFileSync(join(folder, "b.js"), `${big("one")}\n\n//# sourceMappingURL=b.js.map`);
	writeFileSync(join(folder, "ssr", "c.js"), `${big("one")}\n\n//# sourceMappingURL=c.js.map`);
	writeFileSync(join(folder, "other.js"), `${big("two")}\n\n//# sourceMappingURL=other.js.map`);
	writeFileSync(join(folder, "h1.js"), `${hoisted("hoisted")}\n\n//# sourceMappingURL=h1.js.map`);
	writeFileSync(join(folder, "h2.js"), `${hoisted("hoisted")}\n\n//# sourceMappingURL=h2.js.map`);
	writeFileSync(join(folder, "tiny1.js"), "module.exports=[1,(e)=>{}];");
	writeFileSync(join(folder, "tiny2.js"), "module.exports=[1,(e)=>{}];");
	writeFileSync(join(folder, "[turbopack]_runtime.js"), `${big("runtime")}`);
	writeFileSync(join(folder, "[turbopack]_runtime-copy.js"), `${big("runtime")}`);
	writeFileSync(join(folder, "not-a-chunk.js"), `console.log(${JSON.stringify("z".repeat(3000))});`);
	writeFileSync(join(folder, "not-a-chunk-2.js"), `console.log(${JSON.stringify("z".repeat(3000))});`);
});

after(() => rmSync(folder, { recursive: true, force: true }));

describe("dedupe-chunks", () => {
	test("copies of a chunk load the first, whatever folder they are in, and nothing else changes", () => {
		const before = { other: readFileSync(join(folder, "other.js"), "utf8"), tiny: readFileSync(join(folder, "tiny2.js"), "utf8") };
		const result = dedupeFolder(folder);
		assert.deepEqual({ files: result.files, groups: result.groups }, { files: 3, groups: 2 });
		assert.ok(result.saved > 8000);
		assert.equal(readFileSync(join(folder, "b.js"), "utf8"), 'module.exports=require("./a.js");\n');
		assert.equal(readFileSync(join(folder, "ssr", "c.js"), "utf8"), 'module.exports=require("../a.js");\n');
		assert.equal(readFileSync(join(folder, "h2.js"), "utf8"), 'module.exports=require("./h1.js");\n');
		assert.match(readFileSync(join(folder, "a.js"), "utf8"), /marker:"one"/, "the first copy is kept as it was");
		assert.equal(readFileSync(join(folder, "other.js"), "utf8"), before.other, "a different chunk is untouched");
		assert.equal(readFileSync(join(folder, "tiny2.js"), "utf8"), before.tiny, "a file too small to matter is untouched");
		assert.match(readFileSync(join(folder, "[turbopack]_runtime-copy.js"), "utf8"), /marker:"runtime"/, "the runtime is never replaced");
		assert.match(readFileSync(join(folder, "not-a-chunk-2.js"), "utf8"), /^console\.log/, "only files that are module lists are");
	});

	test("a stub hands the loader the same list as the file it points at", () => {
		const first = require(join(folder, "a.js"));
		for (const name of ["b.js", join("ssr", "c.js")]) assert.equal(require(join(folder, name)), first, name);
		assert.equal(require(join(folder, "h2.js")), require(join(folder, "h1.js")));
		assert.equal(first[0], 123);
		assert.equal(typeof first[1], "function");
	});

	test("running it again changes nothing, and a stub is not taken for a copy of anything", () => {
		const names = ["a.js", "b.js", "h1.js", "h2.js", "other.js"];
		const before = names.map((name) => readFileSync(join(folder, name), "utf8"));
		assert.deepEqual(dedupeFolder(folder), { files: 0, saved: 0, groups: 0 });
		assert.deepEqual(names.map((name) => readFileSync(join(folder, name), "utf8")), before);
	});

	test("the stub's path is relative, with the separators of a URL", () => {
		assert.equal(toStub("/x/chunks/ssr/a.js", "/x/chunks/b.js"), 'module.exports=require("../b.js");\n');
		assert.equal(toStub("/x/chunks/a.js", "/x/chunks/ssr/b.js"), 'module.exports=require("./ssr/b.js");\n');
		assert.equal(toStub("/x/chunks/[root]__a.js", "/x/chunks/(b)._.js"), 'module.exports=require("./(b)._.js");\n');
	});
});
