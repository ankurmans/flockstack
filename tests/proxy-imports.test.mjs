import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The middleware bundles every module its imports reach: the site extensions load the support assistant and the AWS SDK,
// which the middleware's bundle can't resolve (the build fails), so proxy.js reads its routing from lib/site-routing.js.
test("proxy.js and the routing modules stay clear of the site extensions and the support assistant", () => {
	for (const path of ["proxy.js", "lib/site-routing.js", "lib/marketing/site-routing.js"]) {
		const imports = read(path)
			.split("\n")
			.filter((line) => /^\s*import\b|\bimport\(/.test(line))
			.join("\n");
		assert.doesNotMatch(imports, /site-extensions|support-assistant|@aws-sdk|image-storage/, path);
	}
	assert.match(read("proxy.js"), /from "@\/lib\/site-routing"/);
});
