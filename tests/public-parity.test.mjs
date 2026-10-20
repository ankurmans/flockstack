import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { PUBLIC_DOC_PATHS, PUBLIC_LEGAL_PATHS } from "../lib/public-routing.js";
import { anonymous, startTestApp, withEnv } from "./helpers/app.mjs";

// The text of each docs and legal page as the app's own page renders it now, against the text of the file the public pages Worker
// serves. It needs the files (`npm run build:public` writes them; without them the tests are skipped, since the suite must run without
// a build). It catches the files going stale against the pages: a page changed and the Worker not rebuilt. Where the page and the
// file differ it says where. The app's rendering of whole responses is compared by scripts/verify-public.mjs.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "workers/public/dist");
const hasFiles = existsSync(join(DIST, "manifest.json"));
const manifest = hasFiles ? JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8")) : null;

const decode = (text) => text.replace(/&#x27;|&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const textOf = (markup) => decode(markup.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const render = async (page) => renderToStaticMarkup(createElement(TooltipProvider, null, await anonymous(async () => page.default())));
const mainOf = (html) => {
	const start = html.indexOf("<main");
	assert.notEqual(start, -1, "a <main> in the file");
	return html.slice(html.indexOf(">", start) + 1, html.lastIndexOf("</main>"));
};

function firstDifference(a, b) {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) index++;
	return index === length && a.length === b.length ? null : { index, page: a.slice(Math.max(0, index - 50), index + 80), file: b.slice(Math.max(0, index - 50), index + 80) };
}

describe("the files of the public pages", { skip: !hasFiles && "workers/public/dist is not built (npm run build:public)" }, () => {
	let app;
	before(async () => {
		app = await startTestApp();
	});
	after(() => app?.stop());

	for (const region of ["us", "eu"]) {
		test(`say what the docs and legal pages say now, in the ${region.toUpperCase()} region`, async () => {
			const appUrl = region === "eu" ? "https://eu.flockstack.io" : "https://flockstack.io";
			await withEnv({ FLOCKSTACK_CLOUD: "true", FLOCKSTACK_REGION: region, APP_URL: appUrl, REGION_URL_US: "https://flockstack.io", REGION_URL_EU: "https://eu.flockstack.io", POSTHOG_KEY: "" }, async () => {
				for (const path of [...PUBLIC_DOC_PATHS, ...PUBLIC_LEGAL_PATHS]) {
					const entry = manifest.regions[region][path];
					assert.ok(entry, `${region} ${path} is in the manifest`);
					const html = readFileSync(join(DIST, "assets", region, entry.file), "utf8");
					const page = await import(`../app/(site)${path}/page.js`);
					if (entry.status === 404) continue;
					const fromPage = textOf(await render(page));
					const fromFile = textOf(mainOf(html));
					// The docs' layout adds its navigation around a page, so a docs page is looked for inside the file's <main>; a legal page is
					// its own column and the whole of it is compared.
					const inFile = PUBLIC_DOC_PATHS.includes(path) ? fromFile.slice(Math.max(0, fromFile.indexOf(fromPage.slice(0, 80)))).slice(0, fromPage.length) : fromFile;
					const difference = firstDifference(fromPage, inFile);
					assert.equal(difference, null, `${region} ${path}: ${JSON.stringify(difference)}`);
				}
			});
		});
	}

	test("hold the same set of pages in both regions, each with the status the app gave it", () => {
		assert.deepEqual(Object.keys(manifest.regions.us).sort(), Object.keys(manifest.regions.eu).sort());
		for (const region of ["us", "eu"]) for (const [path, entry] of Object.entries(manifest.regions[region])) {
			assert.ok(entry.status === 200 || (entry.status === 404 && PUBLIC_LEGAL_PATHS.includes(path)), `${region} ${path}: ${entry.status}`);
			assert.ok(existsSync(join(DIST, "assets", region, entry.file)), `${region} ${path}: the file`);
		}
	});

	test("differ between regions only where the app does: the address and the region", () => {
		const read = (region, path) => readFileSync(join(DIST, "assets", region, manifest.regions[region][path].file), "utf8");
		for (const path of ["/terms", "/privacy", "/sub-processors", "/docs/audiences", "/docs/export", "/docs/errors", "/docs/forms", "/docs/reports", "/docs/warnings"]) {
			assert.equal(textOf(mainOf(read("us", path))), textOf(mainOf(read("eu", path))), `${path} says the same in both regions`);
		}
		assert.match(read("eu", "/docs/mcp"), /eu\.flockstack\.io/);
		assert.doesNotMatch(read("us", "/docs/mcp"), /https:\/\/eu\.flockstack\.io\/mcp/);
	});
});
