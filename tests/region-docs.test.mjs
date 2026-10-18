import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { API_KEY_SCAN_REGEX } from "../lib/api-key-tokens.js";
import { anonymous, startTestApp, withEnv } from "./helpers/app.mjs";

// What the docs, the llms files and the OpenAPI document say about regions: where each kind of data is stored, the key
// formats, and never "EU-resident", which would promise more than the list of what leaves the region allows.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

let app;
let m;

const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = async (page) => renderToStaticMarkup(createElement(TooltipProvider, null, await anonymous(async () => page.default())));

async function listSources(dir) {
	const files = [];
	for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listSources(path)));
		else if (/\.(js|jsx|mjs)$/.test(entry.name)) files.push(path);
	}
	return files;
}

before(async () => {
	app = await startTestApp();
	m = {
		docs: await import("../lib/docs/llms.js"),
		regions: await import("../lib/docs/regions.js"),
		openapi: await import("../lib/docs/openapi.js"),
		page: await import("../app/(site)/docs/regions/page.js"),
		authentication: await import("../app/(site)/docs/authentication/page.js"),
		mcp: await import("../app/(site)/docs/mcp/page.js"),
	};
});

after(() => app?.stop());

describe("/docs/regions", () => {
	test("is a docs page, listed for people, agents and search engines", () => {
		const page = m.docs.DOC_PAGES.find(({ href }) => href === "/docs/regions");
		assert.equal(page.title, "Regions");
		assert.equal(m.docs.getDocsPageMetadata("/docs/regions").alternates.canonical, "/docs/regions");
		assert.match(m.docs.getLlmsIndex("https://flockstack.io"), /\[Regions\]\(https:\/\/flockstack\.io\/docs\/regions\)/);
	});

	test("lists where each kind of data is stored in each region, and what leaves the region", async () => {
		const text = textOf(await render(m.page));
		for (const { what } of m.regions.REGION_DATA) assert.ok(text.includes(what), what);
		for (const phrase of [
			"Cloudflare D1 database",
			"EU jurisdiction",
			"Cloudflare R2 bucket",
			"Amazon SES in eu-west-1",
			"Upstash QStash in its EU region",
			"Upstash QStash in its US region",
			"Polar or Stripe",
			"Your own Stripe account",
			"Cloudflare's Workers logs",
			"What isn't kept in the region",
			"Where the code runs",
			"https://flockstack.io",
			"https://eu.flockstack.io",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
		for (const item of m.regions.REGION_LEAVES) assert.ok(text.includes(item), item);
		assert.match(text, /This server stores its data in the United States/);
		await withEnv({ FLOCKSTACK_REGION: "eu" }, async () => assert.match(textOf(await render(m.page)), /This server stores its data in the European Union/));
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => assert.match(textOf(await render(m.page)), /A server you host yourself has one place for its data/));
	});

	test("the llms reference carries the same section", () => {
		const full = m.docs.getLlmsFull("https://flockstack.io");
		assert.match(full, /\n## Regions\n/);
		assert.ok(full.includes(m.regions.getRegionsMarkdown()));
		assert.match(full, /`mc_eu_`/);
		assert.ok(full.includes(API_KEY_SCAN_REGEX));
	});

	test("nothing in the app says EU-resident", async () => {
		for (const dir of ["app", "lib", "components"]) {
			for (const file of await listSources(dir)) assert.doesNotMatch(await readFile(join(ROOT, file), "utf8"), /EU[- ]resident/i, file);
		}
	});
});

describe("API key format", () => {
	test("the authentication page, the MCP page and the OpenAPI document name both prefixes, and the page gives the secret scanning expression", async () => {
		const authentication = textOf(await render(m.authentication));
		assert.match(authentication, /mc_ , or mc_eu_ for an account in the European Union/);
		assert.match(authentication, /Regions/);
		assert.match(authentication, /A key from the other region answers 401 unauthorized/);
		assert.ok(authentication.includes(API_KEY_SCAN_REGEX));
		assert.match(textOf(await render(m.mcp)), /mc_ , or mc_eu_ for an account in the European Union/);
		assert.match(m.openapi.getOpenApiDocument("https://flockstack.io").components.securitySchemes.apiKey.description, /mc_eu_/);
	});

	test("the README gives the format and the expression", async () => {
		const readme = await readFile(join(ROOT, "README.md"), "utf8");
		assert.ok(readme.includes("`mc_eu_`"));
		assert.ok(readme.includes(API_KEY_SCAN_REGEX));
		assert.match(readme, /^## Regions$/m);
	});
});
