import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The files under /_next/static are named by a hash of their content. Without a rule of its own, Cloudflare's static assets send
// "public, max-age=0, must-revalidate" for them, so every page asked again for every script and style sheet. public/_headers is
// copied into the assets by the build (OpenNext) and read by the platform.
test("public/_headers makes the hashed files under /_next/static immutable, and only those", () => {
	const rules = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
		.split("\n")
		.filter((line) => line.trim() && !line.trim().startsWith("#"));
	assert.deepEqual(rules, ["/_next/static/*", "  Cache-Control: public, max-age=31536000, immutable"]);
});
