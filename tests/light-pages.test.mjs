import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every page and route is code a Worker has to load before it answers: the modules it imports, and theirs. The legal pages, the
// sitemap and robots.txt need none of the app (sign-in, the database, email, the action registry), and once they imported it
// through a constant, a request for /terms took as long to start as the dashboard. This follows the static imports only: a
// module loaded with import() when it is used doesn't count.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXTENSIONS = ["", ".js", ".jsx", ".mjs", "/index.js", "/index.jsx"];
// next.config.mjs and tests/setup/hooks.mjs resolve these to FlockStack Cloud's files where they exist.
const SITE_EXTENSIONS = {
	"lib/site-extensions": "lib/marketing/site-extensions",
	"lib/site-routing": "lib/marketing/site-routing",
	"components/SiteExtensions": "components/marketing/SiteExtensions",
};
const HEAVY = ["lib/auth.js", "lib/db.js", "lib/docdb/model.js", "lib/sending.js", "lib/actions/registry.js", "lib/oauth.js", "lib/stripe.js", "lib/ses.js", "lib/image-storage.js", "lib/rate-limit.js"];

function resolve(specifier, from) {
	const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2)) : specifier.startsWith(".") ? join(from, "..", specifier) : null;
	if (!base) return null;
	const relative = base.slice(ROOT.length);
	for (const candidate of [SITE_EXTENSIONS[relative] ? join(ROOT, SITE_EXTENSIONS[relative]) : null, base]) {
		if (!candidate) continue;
		for (const extension of EXTENSIONS) if (existsSync(candidate + extension) && /\.(m?jsx?)$/.test(candidate + extension)) return candidate + extension;
	}
	return null;
}

function importedFiles(entries) {
	const seen = new Set();
	const parents = new Map();
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
			const target = specifier ? resolve(specifier, file) : null;
			if (target && !seen.has(target)) {
				if (!parents.has(target)) parents.set(target, file);
				queue.push(target);
			}
		}
	}
	return { seen, parents };
}

const light = (...paths) => paths.map((path) => join(ROOT, path));

test("the legal pages, the sitemap and robots.txt load none of the app", () => {
	const entries = light("app/(site)/terms/page.js", "app/(site)/privacy/page.js", "app/(site)/sub-processors/page.js", "app/sitemap.js", "app/robots.js");
	const { seen, parents } = importedFiles(entries);
	for (const heavy of HEAVY) {
		const file = join(ROOT, heavy);
		if (!seen.has(file)) continue;
		const chain = [];
		for (let step = file; step; step = parents.get(step)) chain.push(step.slice(ROOT.length));
		assert.fail(`${heavy} is imported by the light pages: ${chain.reverse().join(" -> ")}`);
	}
	assert.ok(seen.size > 20, "the walk found the pages' imports");
});

test("the docs page list and their metadata load neither the action registry nor the llms writer", () => {
	const { seen } = importedFiles(light("lib/docs/pages.js"));
	assert.equal(seen.has(join(ROOT, "lib/actions/registry.js")), false);
	assert.equal(seen.has(join(ROOT, "lib/docs/llms.js")), false);
});
