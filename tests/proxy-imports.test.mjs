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

// The middleware runs before every request, the app's own included, and evaluates what it imports first: the database layer (the
// document store with mingo, the models) was 1 MB of its 2.9 MB bundle, loaded for requests that never ask a question of it. A request for
// a newsletter's host loads it with its first lookup.
test("the middleware's routing modules load the database layer when they look something up, not when they are imported", () => {
	for (const path of ["lib/host-routing.js", "lib/redirect-routing.js"]) {
		const statics = read(path)
			.split("\n")
			.filter((line) => /^\s*import\b.*from/.test(line))
			.join("\n");
		assert.doesNotMatch(statics, /\/db\.js|models\/|docdb/, `${path} imports the database statically`);
		assert.match(read(path), /import\("\.\/db\.js"\)/, path);
	}
});
