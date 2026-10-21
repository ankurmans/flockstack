import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getWorkerName } from "../lib/custom-hostnames.js";
import { DOC_PAGES } from "../lib/docs/pages.js";
import { LEGAL_PATHS } from "../lib/legal.js";
import { PUBLIC_DOC_PATHS, PUBLIC_EXACT_PATHS, PUBLIC_FILE_PATHS, PUBLIC_LEGAL_PATHS, VARIANT_HEADERS, isPlainVisit, isPublicPath } from "../lib/public-routing.js";
import { WEBSITE_EXACT_PATHS, WEBSITE_PREFIXES, isWebsitePath } from "../lib/website-routing.js";

// The lists the router sends by (lib/public-routing.js, lib/website-routing.js) and the sources they repeat.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

describe("the paths the router hands to the public pages Worker", () => {
	test("are the docs' pages, the legal pages and the routes that write a file, and nothing else", () => {
		assert.deepEqual(PUBLIC_DOC_PATHS, DOC_PAGES.map(({ href }) => href));
		assert.deepEqual(PUBLIC_LEGAL_PATHS, LEGAL_PATHS);
		assert.deepEqual([...PUBLIC_EXACT_PATHS].sort(), [...PUBLIC_LEGAL_PATHS, ...PUBLIC_DOC_PATHS, ...PUBLIC_FILE_PATHS].sort());
		assert.equal(new Set(PUBLIC_EXACT_PATHS).size, PUBLIC_EXACT_PATHS.length, "no path twice");
	});

	test("each has a page or route in the app to be a copy of", () => {
		for (const path of [...PUBLIC_DOC_PATHS, ...PUBLIC_LEGAL_PATHS]) {
			assert.ok(existsSync(join(ROOT, "app/(site)", path, "page.js")), path);
		}
		const files = { "/llms-docs.txt": "app/llms-docs.txt/route.js", "/llms-full.txt": "app/llms-full.txt/route.js", "/api/v1/openapi.json": "app/api/v1/openapi.json/route.js", "/sitemap.xml": "app/sitemap.js", "/robots.txt": "app/robots.js", "/site.webmanifest": "app/site.webmanifest/route.js", "/icon.svg": "app/icon.svg", "/apple-icon.png": "app/apple-icon.png" };
		assert.deepEqual(Object.keys(files).sort(), [...PUBLIC_FILE_PATHS].sort());
		for (const file of Object.values(files)) assert.ok(existsSync(join(ROOT, file)), file);
	});

	test("overlap none of the website's, and leave out what needs the app: /llms.txt merges, /custom and /recommendations read or write", () => {
		for (const path of PUBLIC_EXACT_PATHS) assert.equal(isWebsitePath(path), false, path);
		for (const path of ["/llms.txt", "/custom", "/recommendations", "/opengraph-image", "/signin", "/", "/api/health", "/mcp", "/.well-known/oauth-authorization-server"]) assert.equal(isPublicPath(path), false, path);
	});

	test("every page is static: it reads nothing of the request but what the Worker puts in (the docs and legal pages)", () => {
		// A page that reads the session, the database or its own request cannot be a file. These do none of it.
		for (const path of [...PUBLIC_DOC_PATHS, ...PUBLIC_LEGAL_PATHS]) {
			const source = read(`app/(site)${path}/page.js`);
			assert.doesNotMatch(source, /next\/headers|requireAccount|getSession|from "@\/lib\/db"|authenticateRequest|searchParams/, path);
		}
		assert.match(read("app/(site)/recommendations/page.js"), /Newsletter|find|lib\//, "the directory is read from the database and stays the app's");
	});

	test("a visit is a GET or HEAD without the headers Next.js uses for its own data", () => {
		assert.equal(isPlainVisit({ method: "GET", headers: new Headers() }), true);
		assert.equal(isPlainVisit({ method: "HEAD", headers: new Headers({ accept: "text/html" }) }), true);
		assert.equal(isPlainVisit({ method: "POST", headers: new Headers() }), false);
		for (const name of VARIANT_HEADERS) assert.equal(isPlainVisit({ method: "GET", headers: new Headers({ [name]: "1" }) }), false, name);
	});
});

describe("the router's copy of the website's paths", () => {
	test("is the app's own module, not a second list that could drift", () => {
		const source = read("workers/router/routing.js");
		assert.match(source, /from "\.\.\/\.\.\/lib\/website-routing\.js"/);
		assert.doesNotMatch(source, /"\/pricing"|"\/compare"|WEBSITE_EXACT_PATHS\s*=/);
	});

	// The website is a private repository with its own copy of this module (docs/reference/website-routing.js, tested there). When
	// FLOCKSTACK_WEBSITE_ROUTING names that file, this checks that the two lists are the same.
	test("equals the website repository's reference list, where it is given", { skip: !process.env.FLOCKSTACK_WEBSITE_ROUTING }, async () => {
		const theirs = await import(`file://${process.env.FLOCKSTACK_WEBSITE_ROUTING}`);
		assert.deepEqual(WEBSITE_EXACT_PATHS, theirs.WEBSITE_EXACT_PATHS);
		assert.deepEqual(WEBSITE_PREFIXES, theirs.WEBSITE_PREFIXES);
	});
});

// Wrangler's own esbuild, as scripts/bundle-worker.mjs finds it.
function bundle(entry) {
	const require = createRequire(join(ROOT, "package.json"));
	const esbuild = createRequire(join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js"))("esbuild");
	const result = esbuild.buildSync({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: "esm", minify: true, metafile: true, logLevel: "silent", loader: { ".json": "json" } });
	return { bytes: result.outputFiles[0].contents.length, inputs: Object.keys(result.metafile.inputs) };
}

describe("the router and the public pages Worker stay tiny", () => {
	test("the router is a few kilobytes of its own files: no Next.js, no app code", () => {
		const { bytes, inputs } = bundle("workers/router/index.js");
		assert.deepEqual(inputs.sort(), ["lib/public-routing.js", "lib/region.js", "lib/website-routing.js", "workers/router/index.js", "workers/router/routing.js"]);
		assert.ok(bytes < 12_000, `${bytes} bytes`);
	});

	test("the public pages Worker is the same, and its manifest and files are data beside it", () => {
		const { bytes, inputs } = bundle("workers/public/handler.js");
		assert.deepEqual(inputs.sort(), ["lib/marketing/analytics-config.js", "lib/marketing/analytics-consent.js", "lib/prerender.js", "lib/region.js", "workers/public/handler.js"]);
		assert.ok(bytes < 14_000, `${bytes} bytes`);
	});
});

describe("wrangler configurations", () => {
	const strip = (text) => text.replace(/^\s*\/\/.*$/gm, "");
	const router = JSON.parse(strip(read("workers/router/wrangler.jsonc")));
	const app = JSON.parse(strip(read("wrangler.jsonc")));
	const publicWorker = JSON.parse(strip(read("workers/public/wrangler.jsonc")));
	const service = (config, binding) => config.services.find((entry) => entry.binding === binding)?.service;

	test("the router binds the website, the public pages and its region's app, and carries a domain only in the environments that cut over", () => {
		for (const config of [router, router.env.us, router.env.eu, router.env["eu-staged"]]) {
			assert.equal(service(config, "WEBSITE"), "flockstack-website");
			assert.equal(config.services.length, 3);
			assert.ok(!config.compatibility_flags, "plain JavaScript, no Node compatibility");
		}
		assert.equal(service(router, "PUBLIC"), publicWorker.name);
		assert.equal(service(router.env.us, "PUBLIC"), publicWorker.name);
		assert.equal(service(router.env.eu, "PUBLIC"), publicWorker.env.eu.name, "each region's router has its own region's public Worker");
		assert.equal(service(router.env["eu-staged"], "PUBLIC"), publicWorker.env.eu.name);
		assert.notEqual(publicWorker.name, publicWorker.env.eu.name);
		assert.equal(service(router, "APP"), app.name);
		assert.equal(service(router.env.us, "APP"), app.name);
		assert.equal(service(router.env.eu, "APP"), app.env.eu.name);
		assert.equal(service(router.env["eu-staged"], "APP"), app.env.eu.name);
		assert.equal(router.routes, undefined, "the top level is the staged US router: no domain");
		assert.equal(router.env["eu-staged"].routes, undefined, "so is the staged EU one");
		assert.deepEqual(router.env.us.routes, [{ pattern: "flockstack.io", custom_domain: true }, { pattern: "www.flockstack.io", custom_domain: true }], "www is the router's too, to be redirected to the domain");
		assert.deepEqual(router.env.eu.routes, [{ pattern: "eu.flockstack.io", custom_domain: true }]);
		assert.equal(router.env.us.name, router.name, "the US environment is the same Worker as the staged one");
		assert.equal(router.env.eu.name, router.env["eu-staged"].name);
		assert.notEqual(router.env.eu.name, router.name);
	});

	test("each router reads its region's session cookie and address", () => {
		assert.equal(router.vars.FLOCKSTACK_REGION, "us");
		assert.equal(router.env.us.vars.APP_URL, "https://flockstack.io");
		for (const name of ["eu", "eu-staged"]) {
			assert.equal(router.env[name].vars.FLOCKSTACK_REGION, "eu");
			assert.equal(router.env[name].vars.APP_URL, "https://eu.flockstack.io");
		}
		assert.equal(router.vars.APP_URL, "https://flockstack.io");
	});

	test("the public pages Workers (one per region) have no route, no cron and no bindings of data: files and nothing else", () => {
		for (const [config, region] of [[publicWorker, "us"], [publicWorker.env.eu, "eu"]]) {
			assert.equal(config.routes, undefined);
			assert.equal(config.triggers, undefined);
			for (const key of ["d1_databases", "r2_buckets", "kv_namespaces", "services", "ai", "durable_objects"]) assert.equal(config[key], undefined, key);
			assert.equal(config.assets.binding, "ASSETS");
			assert.equal(config.assets.directory, `./dist/assets/${region}`, "only its own region's files");
			assert.equal(config.assets.run_worker_first, true);
			assert.equal(config.assets.html_handling, "none");
			assert.equal(config.assets.not_found_handling, "none");
			assert.equal(config.main, "index.js");
			assert.equal(config.vars.FLOCKSTACK_REGION, region);
		}
		assert.equal(JSON.stringify(publicWorker).includes("FLOCKSTACK_PRERENDER"), false, "the marker mode is the build script's alone");
	});

	test("a newsletter's own domain and the shared archive hosts still go straight to the app Workers: the Worker routes Cloudflare for SaaS uses name them, not a router", () => {
		assert.equal(getWorkerName({ FLOCKSTACK_REGION: "us" }), app.name);
		assert.equal(getWorkerName({ FLOCKSTACK_REGION: "eu" }), app.env.eu.name);
		assert.equal(getWorkerName({}), app.name);
		for (const name of [router.name, router.env.eu.name, publicWorker.name, publicWorker.env.eu.name]) assert.notEqual(getWorkerName({ FLOCKSTACK_REGION: "us" }), name);
		assert.match(strip(read("wrangler.jsonc")), /newsletter\.ankur\.works/, "the owner's own newsletter domain stays a domain of the app");
		for (const config of [router, router.env.us, router.env.eu, router.env["eu-staged"]]) assert.equal(JSON.stringify(config).includes("newsletter.ankur.works"), false, "no router holds a newsletter's domain");
	});

	test("the app never turns on the marker mode", () => {
		assert.equal(JSON.stringify(app).includes("FLOCKSTACK_PRERENDER"), false);
	});
});
