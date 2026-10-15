import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconUrl } from "../lib/favicon.js";

test("favicon URLs are encoded and sized", () => {
	assert.equal(faviconUrl("example.com", 32), "https://www.google.com/s2/favicons?domain=example.com&sz=32");
	assert.ok(faviconUrl("a b").includes("domain=a%20b"));
});
