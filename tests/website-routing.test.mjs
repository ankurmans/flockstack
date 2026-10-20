import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startTestApp, withEnv } from "./helpers/app.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReservedSlug } from "../lib/reserved-slugs.js";
import { WEBSITE_EXACT_PATHS, WEBSITE_PREFIXES, hasSessionCookie, isWebsitePath, shouldForwardToWebsite } from "../lib/website-routing.js";

// The marketing website is a separate Worker (a private repository). The app's worker-entry.mjs hands it a short list of paths
// through the WEBSITE service binding, and answers everything else itself.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const forward = (overrides) => shouldForwardToWebsite({ method: "GET", hostname: "flockstack.io", appHostname: "flockstack.io", pathname: "/pricing", hasSession: false, ...overrides });

describe("lib/website-routing.js", () => {
	test("forwards the website's paths, with or without a session", () => {
		for (const pathname of ["/pricing", "/compare", "/changelog", "/blog", "/blog/a-post", "/blog/feed.xml", "/vs", "/vs/mailchimp", "/alternatives", "/alternatives/mailchimp", "/switch", "/switch/mailchimp", "/newsletter-api", "/newsletter-mcp-server", "/newsletter-automation", "/paid-newsletter-platform", "/cheapest-newsletter-platform", "/amazon-ses-newsletter", "/self-hosted-newsletter", "/tools/newsletter-cost-calculator", "/llms.txt", "/sitemap-website.xml", "/_website/_next/static/a.js", "/_website/og/home", "/_website/site.webmanifest"]) {
			assert.equal(forward({ pathname }), true, pathname);
			assert.equal(forward({ pathname, hasSession: true }), true, `${pathname} signed in`);
		}
	});

	test("sends / to the website only for a visitor with no session", () => {
		assert.equal(forward({ pathname: "/", hasSession: false }), true);
		assert.equal(forward({ pathname: "/", hasSession: true }), false);
	});

	test("leaves everything else to the app", () => {
		for (const pathname of ["/docs", "/docs/api", "/signin", "/terms", "/privacy", "/sub-processors", "/custom", "/robots.txt", "/sitemap.xml", "/site.webmanifest", "/llms-full.txt", "/llms-docs.txt", "/api/v1/contacts", "/mcp", "/archive/x", "/pricing/extra", "/blogger", "/vsx", "/newsletter-api/extra", "/newsletter", "/_websitefoo", "/campaigns", "/billing", "/tools", "/tools/", "/tools/other", "/tools/newsletter-cost-calculator/extra", "/tools/newsletter-cost-calculator/", "/tool"]) {
			assert.equal(forward({ pathname }), false, pathname);
		}
	});

	test("never forwards a write, nor a request to a newsletter's own domain", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(forward({ method }), false, method);
		assert.equal(forward({ method: "HEAD" }), true);
		assert.equal(forward({ hostname: "news.example.com" }), false);
		assert.equal(forward({ hostname: "news.example.com", pathname: "/" }), false);
	});

	test("reads the session cookie the way proxy.js does: only whether it is there, for the region's prefix", () => {
		assert.equal(hasSessionCookie("a=1; better-auth.session_token=x.y", "better-auth"), true);
		assert.equal(hasSessionCookie("__Secure-better-auth.session_token=x", "better-auth"), true);
		assert.equal(hasSessionCookie("__Secure-flockstack-eu.session_token=x", "flockstack-eu"), true);
		assert.equal(hasSessionCookie("better-auth.session_token=x", "flockstack-eu"), false);
		assert.equal(hasSessionCookie("fs_consent=accepted; better-auth.other=1", "better-auth"), false);
		assert.equal(hasSessionCookie(undefined, "better-auth"), false);
		assert.equal(hasSessionCookie(null, "better-auth"), false);
	});
	test("/llms-docs.txt is the app's own: the website merges it into /llms.txt", () => {
		assert.equal(isWebsitePath("/llms-docs.txt"), false);
		assert.equal(isWebsitePath("/llms.txt"), true);
	});
});

describe("the website's top-level paths", () => {
	test("are reserved slugs, so none is ever a newsletter's address on flockstack.io", () => {
		const segments = [...WEBSITE_EXACT_PATHS, ...WEBSITE_PREFIXES].map((path) => path.split("/")[1]).filter((name) => name && !name.startsWith("_") && !name.includes("."));
		assert.ok(segments.includes("newsletter-api") && segments.includes("vs"));
		for (const name of segments) assert.ok(isReservedSlug(name), name);
	});
});

describe("wrangler.jsonc", () => {
	test("binds the website Worker as WEBSITE on both Workers, since bindings are not inherited", async () => {
		const config = JSON.parse((await readFile(join(ROOT, "wrangler.jsonc"), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
		assert.deepEqual(config.services, [{ binding: "WEBSITE", service: "flockstack-website" }]);
		assert.deepEqual(config.env.eu.services, [{ binding: "WEBSITE", service: "flockstack-website" }]);
	});
});

describe("worker-entry.mjs", () => {
	let dir;
	let worker;
	let openNextCalls;

	before(async () => {
		// worker-entry.mjs imports OpenNext's build (.open-next/worker.js), which only exists after a build: load the entry with that
		// import pointed at a stub, and its relative imports at this checkout.
		dir = await mkdtemp(join(tmpdir(), "worker-entry-"));
		await writeFile(
			join(dir, "open-next.mjs"),
			'export default { fetch: async (request) => { globalThis.__openNextCalls.push(request.url); return new Response("app"); } };\nexport class BucketCachePurge {}\nexport class DOQueueHandler {}\nexport class DOShardedTagCache {}\n'
		);
		const stub = pathToFileURL(join(dir, "open-next.mjs")).href;
		const source = (await readFile(join(ROOT, "worker-entry.mjs"), "utf8"))
			.replaceAll('"./.open-next/worker.js"', JSON.stringify(stub))
			.replaceAll('"./lib/', `"${pathToFileURL(ROOT).href}lib/`);
		await writeFile(join(dir, "worker-entry.mjs"), source);
		openNextCalls = globalThis.__openNextCalls = [];
		worker = (await import(pathToFileURL(join(dir, "worker-entry.mjs")).href)).default;
	});

	after(() => rm(dir, { recursive: true, force: true }));

	const ctx = { waitUntil() {} };
	const websiteCalls = [];
	const WEBSITE = { fetch: async (request) => (websiteCalls.push(request.url), new Response("website")) };
	const ENV = { APP_URL: "https://flockstack.io", FLOCKSTACK_REGION: "us" };

	async function answer(url, { env = { ...ENV, WEBSITE }, method = "GET", cookie } = {}) {
		websiteCalls.length = 0;
		openNextCalls.length = 0;
		const response = await worker.fetch(new Request(url, { method, headers: cookie ? { cookie } : {} }), env, ctx);
		return { body: await response.text(), website: websiteCalls.length === 1, app: openNextCalls.length === 1 };
	}

	test("hands the website's paths to the WEBSITE binding, and everything else to the app", async () => {
		for (const path of ["/pricing", "/compare", "/changelog", "/blog", "/blog/a-post", "/vs/mailchimp", "/switch", "/alternatives/mailchimp", "/newsletter-automation", "/tools/newsletter-cost-calculator", "/llms.txt", "/sitemap-website.xml", "/_website/og/home", "/"]) {
			assert.deepEqual(await answer(`https://flockstack.io${path}`), { body: "website", website: true, app: false }, path);
		}
		for (const path of ["/docs", "/signin", "/robots.txt", "/sitemap.xml", "/llms-docs.txt", "/llms-full.txt", "/api/v1/newsletters", "/campaigns"]) {
			assert.deepEqual(await answer(`https://flockstack.io${path}`), { body: "app", website: false, app: true }, path);
		}
	});

	test("hands the calculator to the website as the visitor sent it: query string kept, no session needed, no redirect, in either region", async () => {
		const path = "/tools/newsletter-cost-calculator";
		const query = "?utm_source=newsletter&utm_campaign=a%20b&x=1";
		for (const [origin, env] of [
			["https://flockstack.io", { ...ENV, WEBSITE }],
			["https://eu.flockstack.io", { APP_URL: "https://eu.flockstack.io", FLOCKSTACK_REGION: "eu", WEBSITE }],
		]) {
			for (const cookie of [undefined, "__Secure-better-auth.session_token=x", "__Secure-flockstack-eu.session_token=x"]) {
				websiteCalls.length = 0;
				openNextCalls.length = 0;
				const response = await worker.fetch(new Request(`${origin}${path}${query}`, { headers: cookie ? { cookie } : {} }), env, ctx);
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("location"), null, "the Worker doesn't redirect it, to sign-in or anywhere");
				assert.deepEqual(websiteCalls, [`${origin}${path}${query}`], "the website gets the same address, query string included");
				assert.deepEqual(openNextCalls, [], "the app doesn't see it");
			}
		}
		assert.equal((await answer(`https://flockstack.io${path}`, { method: "HEAD" })).website, true);
		assert.equal((await answer(`https://flockstack.io${path}`, { method: "POST" })).app, true, "a write is the app's");
	});

	test("what is near the calculator's path stays the app's, which answers an unknown path with its own 404", async () => {
		for (const path of ["/tools", "/tools/", "/tools/other", "/tools/newsletter-cost-calculator/extra", "/tool", "/tools.json"]) {
			assert.deepEqual(await answer(`https://flockstack.io${path}`), { body: "app", website: false, app: true }, path);
		}
	});

	test("keeps / for the dashboard when there is a session, in either region's cookie", async () => {
		assert.equal((await answer("https://flockstack.io/", { cookie: "__Secure-better-auth.session_token=x" })).app, true);
		assert.equal((await answer("https://flockstack.io/", { cookie: "fs_consent=accepted" })).website, true);
		const eu = { APP_URL: "https://eu.flockstack.io", FLOCKSTACK_REGION: "eu", WEBSITE };
		assert.equal((await answer("https://eu.flockstack.io/", { env: eu, cookie: "__Secure-flockstack-eu.session_token=x" })).app, true);
		assert.equal((await answer("https://eu.flockstack.io/", { env: eu, cookie: "better-auth.session_token=x" })).website, true, "the US cookie is not an EU session");
		assert.equal((await answer("https://eu.flockstack.io/pricing", { env: eu })).website, true);
	});

	test("forwards nothing without the binding or APP_URL, to a custom domain, or for a write", async () => {
		assert.equal((await answer("https://flockstack.io/pricing", { env: ENV })).app, true, "no binding: a self-hosted server");
		assert.equal((await answer("https://flockstack.io/pricing", { env: { WEBSITE, FLOCKSTACK_REGION: "us" } })).app, true, "no APP_URL");
		assert.equal((await answer("https://news.example.com/pricing")).app, true, "a newsletter's own domain");
		assert.equal((await answer("https://news.example.com/")).app, true, "a newsletter's own domain");
		assert.equal((await answer("https://flockstack.io/pricing", { method: "POST" })).app, true, "a POST");
	});
});

describe("/llms-docs.txt", () => {
	let app;
	let docs;
	let route;

	before(async () => {
		app = await startTestApp();
		docs = await import("../lib/docs/llms.js");
		route = await import("../app/llms-docs.txt/route.js");
	});

	after(() => app?.stop());

	test("is the docs part of /llms.txt: no title, summary, changelog or pricing, which are the website's", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "true", APP_URL: "https://flockstack.io", LEGAL_PREVIEW: "true" }, async () => {
			const whole = docs.getLlmsIndex("https://flockstack.io");
			assert.match(whole, /^# FlockStack\n/);
			assert.match(whole, /## Changelog\n\n- \[Changelog\]\(https:\/\/flockstack\.io\/changelog\): What changed in FlockStack Cloud, newest first\./);
			assert.match(whole, /## Pricing\n\n- \[Pricing\]\(https:\/\/flockstack\.io\/pricing\)/);

			const part = docs.getLlmsIndex("https://flockstack.io", { docsOnly: true });
			assert.doesNotMatch(part, /^# FlockStack|^> |## Changelog|## Pricing/m);
			assert.match(part, /^REST API: https:\/\/flockstack\.io\/api\/v1, with Authorization: Bearer/);
			for (const heading of ["## Docs", "## Legal", "## Endpoints"]) assert.ok(part.includes(heading), heading);

			const response = route.GET();
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-type"), /^text\/plain/);
			assert.equal(await response.text(), part);
			assert.equal(route.dynamic, "force-dynamic");
		});
	});

	test("reaches visitors without a session", async () => {
		const { proxy } = await import("../proxy.js");
		const { NextRequest } = await import("next/server");
		const response = await proxy(new NextRequest(new URL("/llms-docs.txt", "http://localhost:3000"), { headers: { host: "localhost:3000" } }));
		assert.ok(response.headers.get("x-middleware-next"));
	});
});

describe("the docs link to the website's product pages", () => {
	let app;
	before(async () => {
		app = await startTestApp();
	});
	after(() => app?.stop());

	test("on FlockStack Cloud only, as plain links to paths the app forwards", async () => {
		const { createElement } = await import("react");
		const { renderToStaticMarkup } = await import("react-dom/server");
		const { TooltipProvider } = await import("../components/ui/tooltip.jsx");
		const links = { api: "/newsletter-api", mcp: "/newsletter-mcp-server", audiences: "/newsletter-automation", selling: "/paid-newsletter-platform" };
		for (const [doc, href] of Object.entries(links)) {
			const page = (await import(`../app/(site)/docs/${doc}/page.js`)).default;
			assert.equal(isWebsitePath(href), true, href);
			const render = async () => renderToStaticMarkup(createElement(TooltipProvider, null, await page()));
			await withEnv({ FLOCKSTACK_CLOUD: "true" }, async () => assert.match(await render(), new RegExp(`<a href="${href}"`), doc));
			await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => assert.doesNotMatch(await render(), new RegExp(`href="${href}"`), doc));
		}
	});
});
