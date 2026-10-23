import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { READER_GROUPS, READER_PATHS, getReaderGroup, isReaderPath, parseReaderGroups } from "../lib/reader-routing.js";
import { READER_ROUTES } from "../workers/readers/handler.js";

// The paths the router sends to the readers Worker (lib/reader-routing.js) are the routes the app has for them, the proxy lets all of them
// through on every host, and the Worker's route table is the app's files. One list, checked from every side.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TOKEN = "6650f1c2e9b1d4a012345678.AbCdEfGhIjKlMnOpQrStUv";
const SAMPLES = {
	"app/o/[token]/route.js": `/o/${TOKEN}`,
	"app/c/[token]/route.js": `/c/${TOKEN}.aHR0cHM6Ly9leGFtcGxlLmNvbQ`,
	"app/api/unsubscribe/route.js": "/api/unsubscribe",
	"app/api/views/route.js": "/api/views",
	"app/api/visit/route.js": "/api/visit",
	"app/api/recommendations/impression/route.js": "/api/recommendations/impression",
	"app/f/[id]/route.js": "/f/6650f1c2e9b1d4a012345678",
	"app/api/embed-script/route.js": "/embed.js",
};

function readPatterns(source, name) {
	const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(source)[1];
	return [...block.matchAll(/^\t(\/.*\/i?),$/gm)].map(([, text]) => {
		const last = text.lastIndexOf("/");
		return new RegExp(text.slice(1, last), text.slice(last + 1));
	});
}

describe("the reader paths and the app's routes", () => {
	test("every route the readers Worker serves is a file of the app, in its table once, with the path its group lists", () => {
		assert.deepEqual(READER_ROUTES.map(({ file }) => file).sort(), Object.keys(SAMPLES).sort());
		for (const { file, group } of READER_ROUTES) {
			assert.ok(statSync(join(ROOT, file)).isFile(), file);
			const path = SAMPLES[file];
			assert.equal(getReaderGroup(path), group, `${path} is in ${group}`);
			assert.equal(READER_ROUTES.filter((route) => route.match(path)).length, 1, `${path} matches one route`);
		}
	});

	test("every group has paths, and every pattern is a route", () => {
		assert.deepEqual(Object.keys(READER_PATHS).sort(), [...READER_GROUPS].sort());
		for (const group of READER_GROUPS) {
			for (const pattern of READER_PATHS[group]) {
				assert.ok(Object.values(SAMPLES).some((path) => pattern.test(path)), `${group}: ${pattern}`);
			}
		}
	});

	test("the proxy lets all of them through without a session, and on a newsletter's host", () => {
		const source = readFileSync(join(ROOT, "proxy.js"), "utf8");
		const open = readPatterns(source, "PUBLIC_PATHS");
		const archive = readPatterns(source, "ARCHIVE_HOST_PATHS");
		for (const path of Object.values(SAMPLES)) {
			if (path === "/embed.js") continue; // rewritten before anything else, on every host
			assert.ok(open.some((pattern) => pattern.test(path)), `${path} is public in proxy.js`);
			assert.ok(archive.some((pattern) => pattern.test(path)), `${path} is open on a newsletter's host`);
		}
		assert.match(source, /pathname === "\/embed\.js"\) return rewriteTo\(request, "\/api\/embed-script"\)/);
	});

	test("pages and look-alikes stay with the app", () => {
		const stay = ["/unsubscribe", "/confirm", "/keep", "/preferences", "/poll", "/survey", "/pledge", "/gift", "/embed/6650f1c2e9b1d4a012345678", "/f/not-hex", "/f/6650f1c2e9b1d4a01234567", "/f/6650f1c2e9b1d4a0123456789", "/f/6650f1c2e9b1d4a012345678/x", "/o", "/o/", "/o/a/b", "/c", "/c/a/b", "/api/unsubscribe/x", "/api/views/x", "/api/visit2", "/api/recommendations", "/embed.js.map", "/api/embed-script", "/p/some-issue", "/reader/in", "/archive/news/feed", "/signin", "/"];
		for (const path of stay) assert.equal(getReaderGroup(path), null, path);
	});

	test("a trailing slash is the same address, as it is for Next.js", () => {
		assert.equal(getReaderGroup("/api/unsubscribe/"), "unsubscribe");
		assert.equal(getReaderGroup(`/o/${TOKEN}/`), "tracking");
		assert.equal(isReaderPath("/embed.js/"), true);
	});

	test("groups parse like the API's: all, none, a list, and a typo switches less on", () => {
		assert.deepEqual([...parseReaderGroups("all")].sort(), [...READER_GROUPS].sort());
		assert.deepEqual([...parseReaderGroups("true")].sort(), [...READER_GROUPS].sort());
		for (const off of [undefined, null, "", "false", "off", "0", "nonsense"]) assert.equal(parseReaderGroups(off).size, 0, String(off));
		assert.deepEqual([...parseReaderGroups(" Tracking , beacons,bogus")].sort(), ["beacons", "tracking"]);
	});
});
