import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";

// The dashboard installs as an app: a manifest with icons that exist, linked from the dashboard's layouts, and nothing that
// caches or works offline.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		manifest: await import("../app/site.webmanifest/route.js"),
		appLayout: await import("../app/(app)/layout.js"),
		accountLayout: await import("../app/(account)/layout.js"),
		siteLayout: await import("../app/(site)/layout.js"),
		webApp: await import("../lib/web-app.js"),
	};
});

after(() => app?.stop());

const publicFile = (name) => new URL(`../public${name}`, import.meta.url);

function readPngSize(bytes) {
	assert.equal(bytes.subarray(1, 4).toString(), "PNG");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the manifest", () => {
	test("makes a standalone app that starts at the dashboard, inside its own scope", async () => {
		const response = m.manifest.GET();
		assert.equal(response.headers.get("content-type"), "application/manifest+json");
		const manifest = await response.json();
		assert.equal(manifest.name, "FlockStack");
		assert.equal(manifest.display, "standalone");
		assert.equal(manifest.start_url, "/");
		assert.equal(manifest.scope, "/");
		assert.equal(manifest.id, "/");
		assert.ok(manifest.start_url.startsWith(manifest.scope));
		assert.match(manifest.background_color, /^#[0-9a-f]{6}$/);
		assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
		assert.ok(manifest.description.length > 10);
	});

	test("has the 192 and 512 pixel icons Chrome asks for, and they are the sizes they say", async () => {
		const { icons } = await m.manifest.GET().json();
		assert.deepEqual(icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);
		for (const { src, sizes, type } of icons) {
			assert.equal(type, "image/png");
			assert.ok(existsSync(publicFile(src)), `${src} is in public/`);
			const { width, height } = readPngSize(readFileSync(publicFile(src)));
			assert.equal(`${width}x${height}`, sizes, src);
		}
	});

	test("offers shortcuts to pages that exist, with an icon each", async () => {
		const { shortcuts } = await m.manifest.GET().json();
		assert.deepEqual(shortcuts.map(({ url }) => url), ["/campaigns", "/contacts"]);
		for (const shortcut of shortcuts) assert.equal(shortcut.icons[0].sizes, "192x192");
		for (const url of shortcuts.map((shortcut) => shortcut.url)) {
			assert.ok(existsSync(new URL(`../app/(app)${url}/page.js`, import.meta.url)) || existsSync(new URL(`../app/(app)${url}/(list)/page.js`, import.meta.url)), url);
		}
	});
});

describe("the links to it", () => {
	test("the dashboard's layouts and the public pages link the manifest, and the dashboard opens as a web app on Safari", () => {
		for (const layout of [m.appLayout, m.accountLayout]) {
			assert.equal(layout.metadata.manifest, "/site.webmanifest");
			assert.deepEqual(layout.metadata.appleWebApp, { capable: true, title: "FlockStack", statusBarStyle: "default" });
		}
		assert.equal(m.siteLayout.metadata.manifest, m.webApp.WEB_APP_METADATA.manifest);
	});

	test("the manifest and the icons open without a session", async () => {
		const { proxy } = await import("../proxy.js");
		const { NextRequest } = await import("next/server");
		for (const path of ["/site.webmanifest"]) {
			const response = await proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:3000" } }));
			assert.ok(response.headers.get("x-middleware-next"), `${path} needs no sign-in`);
		}
	});
});

describe("offline", () => {
	test("there is no service worker and nothing registers one: the installed app needs the network, like the tab", () => {
		const names = readdirSync(new URL("../public", import.meta.url));
		assert.deepEqual(names.filter((name) => /^(sw|service-?worker|workbox)/i.test(name)), []);
		const source = readFileSync(new URL("../components/LayoutDashboard.jsx", import.meta.url), "utf8") + readFileSync(new URL("../app/layout.js", import.meta.url), "utf8");
		assert.doesNotMatch(source, /serviceWorker/);
		const manifestSource = readFileSync(new URL("../app/site.webmanifest/route.js", import.meta.url), "utf8");
		assert.doesNotMatch(manifestSource, /serviceworker|offline/i);
	});
});
