import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { attributeChunk, attributeHandler, decodeMappings, describeSource } from "../scripts/chunk-attribution.mjs";

// scripts/chunk-attribution.mjs: what the app handler's bytes belong to (docs/PERF-RELEASE-ANALYSIS.md). The decoding is checked on small maps made by hand; a built handler
// is only read when one exists.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("source maps", () => {
	test("decodes the segments of a map, with sources and without", () => {
		assert.deepEqual(decodeMappings("AAAA,KCAK;AAEA,E"), [
			{ line: 0, col: 0, source: 0 },
			{ line: 0, col: 5, source: 1 },
			{ line: 1, col: 0, source: 1 },
			{ line: 1, col: 2, source: -1 },
		]);
		assert.deepEqual(decodeMappings(""), []);
		assert.equal(decodeMappings("gBAAA")[0].col, 16, "a value of two digits");
	});

	test("counts the bytes between one segment and the next on a line, and to the end of the line for the last", () => {
		const bytes = attributeChunk("aaaaabbbbb\ncccc", { mappings: "AAAA,KCAK;ADAA", sources: ["a.js", "b.js"] });
		assert.equal(bytes.get("a.js"), 5 + 5, "the first five bytes, and the second line");
		assert.equal(bytes.get("b.js"), 6, "five bytes and the line break");
	});

	test("reads an indexed map by sections, with the offset of each", () => {
		const bytes = attributeChunk("x\nyyyy\n", { sections: [{ offset: { line: 1, column: 0 }, map: { mappings: "AAAA", sources: ["z.js"] } }] });
		assert.equal(bytes.get("z.js"), 5);
	});

	test("names a package (scoped or not) and a file of the project", () => {
		assert.deepEqual(describeSource("../../../../node_modules/%40better-auth/core/dist/x.mjs"), { kind: "package", name: "@better-auth/core" });
		assert.deepEqual(describeSource("../../../node_modules/.pnpm/x/node_modules/zod/v4/index.js"), { kind: "package", name: "zod" });
		assert.deepEqual(describeSource("../../../../lib/actions/campaigns.js"), { kind: "project", name: "lib/actions/campaigns.js" });
		assert.deepEqual(describeSource("[project]/app/(site)/docs/page.js"), { kind: "project", name: "app/(site)/docs/page.js" });
	});
});

describe("a built handler", { skip: !(existsSync(`${ROOT}.open-next/server-functions/default/handler.mjs.meta.json`) && existsSync(`${ROOT}.next/server/chunks`)) && "not built, or .next was removed after the build" }, () => {
	test("most of the chunk bytes have a source, in both layers, and the framework and the project both show", () => {
		const { packages, files, layers, handlerBytes } = attributeHandler();
		assert.ok(layers.ssr > 1e6 && layers.rsc > 1e6);
		assert.ok(layers.ssr + layers.rsc < handlerBytes, "never more than the handler");
		assert.ok(layers.ssr + layers.rsc > handlerBytes * 0.4);
		assert.ok(packages.has("next") && packages.has("zod"));
		assert.ok([...files.keys()].some((name) => name.startsWith("lib/")));
	});
});
