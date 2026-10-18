import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp, withEnv } from "./helpers/app.mjs";

// What every Worker's first request loads (the proxy, the docs and their layouts, the sitemap, robots.txt, the llms files,
// the OpenAPI document, the directory) has to load on Workers too. Workers refuse to compile WebAssembly at runtime, and a
// module that tries as it loads (undici, under @vercel/blob) leaves a rejection nobody handles, logged as an error on
// requests that answer 200.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const rejections = [];
process.on("unhandledRejection", (reason) => rejections.push(reason));

function refuseWasm() {
	throw new WebAssembly.CompileError("WebAssembly.compile(): Wasm code generation disallowed by embedder");
}
WebAssembly.compile = async () => refuseWasm();
WebAssembly.instantiate = async (source) => (source instanceof WebAssembly.Module ? new WebAssembly.Instance(source) : refuseWasm());

let app;

before(async () => {
	app = await startTestApp({ IMAGES_STORAGE: "r2", IMAGES_CDN_URL: "https://images.example.com", BLOB_READ_WRITE_TOKEN: "" });
});

after(() => app?.stop());

async function importFile(path) {
	return import(pathToFileURL(join(ROOT, path)).href);
}

async function render(element) {
	const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
	return renderToStaticMarkup(createElement(TooltipProvider, null, await element));
}

test("the public pages and files load and answer without a rejection nobody handles, and without Vercel Blob", async () => {
	const { proxy } = await import("../proxy.js");
	const { NextRequest } = await import("next/server");
	for (const path of ["/sitemap.xml", "/docs/recommendations", "/recommendations", "/llms.txt"]) {
		await proxy(new NextRequest(new URL(path, "http://localhost:3000"), { headers: { host: "localhost:3000" } }));
	}

	assert.ok((await importFile("app/sitemap.js")).default().length > 0);
	assert.ok((await importFile("app/robots.js")).default().sitemap);
	for (const route of ["app/llms.txt/route.js", "app/llms-full.txt/route.js", "app/api/v1/openapi.json/route.js"]) {
		assert.equal((await importFile(route)).GET().status, 200, route);
	}

	const { default: SiteLayout } = await importFile("app/(site)/layout.js");
	const { default: DocsLayout } = await importFile("app/(site)/docs/layout.js");
	const pages = (await readdir(join(ROOT, "app/(site)/docs"), { recursive: true })).filter((file) => /(^|\/)page\.js$/.test(file));
	assert.ok(pages.includes("recommendations/page.js"));
	for (const file of pages) {
		const { default: Page } = await importFile(`app/(site)/docs/${file}`);
		const markup = await render(anonymous(async () => createElement(SiteLayout, null, createElement(DocsLayout, null, await Page()))));
		assert.match(markup, /data-layout="docs"/, file);
	}
	const { default: Directory } = await importFile("app/(site)/recommendations/page.js");
	await render(anonymous(() => Directory({ searchParams: Promise.resolve({}) })));

	// Rejections are reported once the microtasks have run.
	await nextTurn();
	await nextTurn();
	assert.deepEqual(rejections.map(String), []);
	assert.equal(globalThis.vercelBlobLoaded, undefined, "@vercel/blob loads only when images go to Vercel Blob");
});

test("Vercel Blob still takes the images when it is the storage", async () => {
	const { putImage } = await import("../lib/image-storage.js");
	const env = { IMAGES_STORAGE: "", BLOB_READ_WRITE_TOKEN: "blob-test" };
	const { url } = await withEnv(env, () => putImage("accounts/abc/images/logo.png", new Uint8Array([1, 2, 3]), "image/png"));
	assert.match(url, /^https:\/\/blob\.example\.com\/accounts\/abc\/images\/logo-1\.png$/);
	assert.equal(globalThis.vercelBlobLoaded, true);
});
