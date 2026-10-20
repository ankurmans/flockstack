import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_ROUTES, isAppRoute } from "../lib/app-routes.js";

// The dashboard's pages, the ones proxy.js sends a signed-out visitor to sign in from. Every other path goes on to
// Next.js, so the list has to name every top-level folder of the dashboard, and each of those pages has to check the
// session itself: the list only decides where a visitor lands.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Dashboard pages outside the route groups: the newsletter setup, and the page a deleted account waits on.
const STANDALONE = ["/admin", "/welcome", "/restore"];

async function folders(group) {
	const entries = await readdir(join(ROOT, group), { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("(")).map(({ name }) => `/${name}`);
}

describe("app routes", () => {
	test("name every top-level folder of the dashboard, and nothing else", async () => {
		const expected = [...(await folders("app/(app)")), ...(await folders("app/(account)")), ...STANDALONE].sort();
		assert.deepEqual([...APP_ROUTES].sort(), expected);
	});

	test("match whole segments only", () => {
		for (const path of ["/campaigns", "/campaigns/abc123", "/billing/checkout", "/admin", "/welcome"]) assert.ok(isAppRoute(path), path);
		for (const path of ["/", "/campaigns-guide", "/blog", "/pricing", "/docs/api", "/archive/weekly", "/signin", "/accounts"]) assert.ok(!isAppRoute(path), path);
	});

	test("each one checks the session itself, in its layout or its page", async () => {
		const guards = {
			"app/(app)/layout.js": /await requireAccount\(\)/,
			"app/(account)/layout.js": /await requireAccount\(\)/,
			"app/admin/layout.js": /await requireAdmin\(\)/,
			"app/welcome/page.js": /requireAccount\(/,
			"app/restore/page.js": /redirect\("\/signin"\)/,
		};
		for (const [file, guard] of Object.entries(guards)) assert.match(await readFile(join(ROOT, file), "utf8"), guard, file);
	});
});
