import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activate, anonymous, as, catchRedirect, form, listPlanPrices, mockStripe, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// The public side of the app on every server: where / sends signed-out visitors, which paths open without a session,
// the plan buttons' way through sign-in to Checkout, and what the pages, the sitemap, robots.txt
// and the web manifest tell search engines and browsers.
// FlockStack Cloud's marketing site adds to it through the site extensions (tests/marketing/site.test.mjs).
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE_URL = "https://flockstack.io";
const CHECKOUT = "/billing/checkout?plan=growth&interval=year";
// The companies that send the emails.
const PROVIDERS = /Amazon|\bAWS\b|\bSES\b|PostShiba|Resend/;

let app;
let m;
let calls;

function stripeApi({ method, path, query, body }) {
	calls.push({ method, path, query, body });
	if (method === "GET" && path === "/v1/prices") return listPlanPrices(query);
	if (method === "POST" && path === "/v1/checkout/sessions") return { id: "cs_test_site", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_site" };
	return { status: 404, error: { type: "invalid_request_error", message: `No mock for ${method} ${path}` } };
}

function visit(path, { cookie } = {}) {
	const request = new m.NextRequest(new URL(path, "http://localhost:3000"), { headers: { host: "localhost:3000", ...(cookie && { cookie }) } });
	return m.proxy(request);
}

// What the proxy decided: render the page asked for, render another one in its place, or redirect.
function outcome(response) {
	const rewrite = response.headers.get("x-middleware-rewrite");
	if (rewrite) return { rewrite: new URL(rewrite).pathname };
	if (response.headers.get("x-middleware-next")) return { next: true };
	return { status: response.status, location: response.headers.get("location") };
}

function cookieOf(user) {
	return [...user.jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function checkout(path = CHECKOUT) {
	return m.checkout.GET(new Request(new URL(path, "http://localhost:3000")));
}

// Signs in through the form with a next path, the way the sign-in page passes it on.
async function signInTo(email, next) {
	const user = { email, jar: new Map(), ip: "198.51.100.200" };
	await as(user, () => m.signin.sendSigninCode(null, form({ email })));
	const code = platformEmails.findLast(({ to }) => to.includes(email)).subject.slice(0, 6);
	const url = await as(user, () => catchRedirect(m.signin.verifySigninCode(null, form({ email, code, next }))));
	return { user, url };
}

function withSiteUrl(run) {
	const appUrl = process.env.APP_URL;
	process.env.APP_URL = SITE_URL;
	try {
		return run();
	} finally {
		process.env.APP_URL = appUrl;
	}
}

async function exists(path) {
	return access(join(ROOT, path)).then(
		() => true,
		() => false
	);
}

function importFile(path) {
	return import(pathToFileURL(join(ROOT, path)).href);
}

// Each page of app/(site) with the paths it renders: route groups leave no trace in a path, and a [slug] folder
// stands for any one segment. Static folders come first, as Next.js matches them.
async function listSitePages() {
	const files = (await readdir(join(ROOT, "app/(site)"), { recursive: true })).filter((file) => /(^|\/)page\.js$/.test(file));
	return files
		.map((file) => {
			const route = `/${file}`.replace(/\/page\.js$/, "").replace(/\/\([^)]+\)/g, "") || "/";
			return { file: `app/(site)/${file}`, pattern: new RegExp(`^${route.replace(/\[(\w+)\]/g, "(?<$1>[^/]+)")}$`), isDynamic: route.includes("[") };
		})
		.sort((a, b) => a.isDynamic - b.isDynamic);
}

// Where the app's own pages and routes start: everything outside app/(site), up to its first [segment]. The
// dashboard's / is left out, since signed-out visitors get the landing page there.
async function listAppRoutes() {
	const files = (await readdir(join(ROOT, "app"), { recursive: true })).filter((file) => /(^|\/)(page|route)\.js$/.test(file) && !file.startsWith("(site)/"));
	const routes = files.map((file) => `/${file}`.replace(/\/(page|route)\.js$/, "").replace(/\/\([^)]+\)/g, "").replace(/\/\[.*$/, ""));
	return [...new Set(routes)].filter(Boolean);
}

// A public path's page and metadata, with the landing page rendered at landingPath (proxy.js).
async function readPage(path) {
	const renderedAt = path === "/" ? m.siteExtensions.landingPath : path;
	for (const { file, pattern } of await listSitePages()) {
		const match = pattern.exec(renderedAt);
		if (!match) continue;
		const page = await importFile(file);
		return { file, metadata: page.metadata ?? (await page.generateMetadata({ params: Promise.resolve({ ...match.groups }) })) };
	}
	assert.fail(`No page in app/(site) renders ${path}`);
}

// The title as Next.js writes it: in the template of the nearest layout above the page's folder, since a layout's
// template doesn't reach the page next to it.
async function resolveTitle(file, title) {
	if (title?.absolute) return title.absolute;
	for (let folder = dirname(dirname(file)); folder !== "."; folder = dirname(folder)) {
		const layout = `${folder}/layout.js`;
		const template = (await exists(layout)) && (await importFile(layout)).metadata?.title?.template;
		if (template) return template.replace("%s", title);
	}
	return title;
}

before(async () => {
	app = await startTestApp();
	m = {
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		checkout: await import("../app/(account)/billing/checkout/route.js"),
		signin: await import("../app/signin/actions.js"),
		sitemap: (await import("../app/sitemap.js")).default,
		robots: (await import("../app/robots.js")).default,
		auth: await import("../lib/auth.js"),
		config: await import("../lib/config.js"),
		docs: await import("../lib/docs/llms.js"),
		format: await import("../lib/format.js"),
		plans: await import("../lib/plans.js"),
		site: await import("../lib/site.js"),
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		validation: await import("../lib/validation.js"),
	};
});

beforeEach(() => {
	calls = [];
	mockStripe(stripeApi);
});

after(() => app?.stop());

describe("/", () => {
	test("signed-out visitors get the marketing site's landing page where there is one, else sign-in; with a session, / stays the dashboard", async () => {
		const { landingPath } = m.siteExtensions;
		assert.deepEqual(outcome(await visit("/")), landingPath ? { rewrite: landingPath } : { status: 307, location: "http://localhost:3000/signin" });

		const user = await signIn("home@example.com");
		assert.ok(cookieOf(user).includes("better-auth.session_token="));
		assert.deepEqual(outcome(await visit("/", { cookie: cookieOf(user) })), { next: true });
	});

	test("the dashboard at / opens for a signed-in user, plan or not", async () => {
		const user = await signIn("dashboard@example.com");
		assert.equal(String((await as(user, () => m.auth.requireAccount())).account._id), String(user.accountId));
		await activate(user);
		assert.equal(String((await as(user, () => m.auth.requireAccount())).account._id), String(user.accountId));
		assert.equal(await anonymous(() => catchRedirect(m.auth.requireAccount())), "/signin");
	});
});

describe("public pages", () => {
	test("the marketing site's pages, the docs, the sitemap, robots.txt, the share image and the llms files open without a session", async () => {
		const paths = [
			...m.siteExtensions.publicPages.filter((path) => path !== "/"),
			...m.docs.DOC_PAGES.map(({ href }) => href),
			"/sitemap.xml",
			"/robots.txt",
			"/opengraph-image-12o0cb",
			"/llms.txt",
			"/llms-full.txt",
			"/api/health",
		];
		for (const path of paths) assert.deepEqual(outcome(await visit(path)), { next: true }, path);
	});

	test("the dashboard, the admin and the account's API still need a session", async () => {
		for (const path of ["/campaigns", "/contacts", "/billing", "/admin", "/api-keys"]) {
			assert.deepEqual(outcome(await visit(path)), { status: 307, location: `http://localhost:3000/signin?next=${encodeURIComponent(path)}` }, path);
		}
		const api = await visit("/api/uploads");
		assert.equal(api.status, 401);
	});

	test("every docs page exists in app/(site)", async () => {
		for (const { href } of m.docs.DOC_PAGES) assert.ok(await exists(`app/(site)${href}/page.js`), href);
	});
});

describe("plan buttons", () => {
	test("lead a signed-out visitor through sign-in to Stripe Checkout for the plan they picked", async () => {
		const redirect = outcome(await visit(CHECKOUT));
		assert.equal(redirect.status, 307);
		const signinUrl = new URL(redirect.location);
		assert.equal(signinUrl.pathname, "/signin");
		assert.equal(signinUrl.searchParams.get("next"), CHECKOUT);

		const { user, url } = await signInTo("plan-button@example.com", signinUrl.searchParams.get("next"));
		assert.equal(url, CHECKOUT);
		assert.equal(await as(user, () => catchRedirect(checkout(url))), "https://checkout.stripe.com/c/pay/cs_test_site");
		const created = calls.find(({ path }) => path === "/v1/checkout/sessions").body;
		assert.equal(created.get("line_items[0][price]"), "price_flockstack_growth_yearly");
		assert.equal(created.get("customer_email"), "plan-button@example.com");
	});

	test("a visitor whose session expired is sent to sign in, with the plan kept", async () => {
		const url = new URL(await anonymous(() => catchRedirect(checkout())), "http://localhost:3000");
		assert.equal(url.pathname, "/signin");
		assert.equal(url.searchParams.get("next"), CHECKOUT);
	});

	test("an account that already pays, or an unknown plan, gets the billing page and no Stripe call", async () => {
		const user = await signIn("already-paying@example.com");
		assert.equal(await as(user, () => catchRedirect(checkout("/billing/checkout?plan=platinum"))), "/billing?interval=month");
		await activate(user);
		assert.equal(await as(user, () => catchRedirect(checkout())), "/billing?interval=year");
		assert.equal(calls.length, 0);
	});

	// A 400 rather than a 500: the Stripe client retries 500s and leaves its 80-second timeout running.
	test("when Stripe answers with an error, the plan picker says so", async () => {
		mockStripe(() => ({ status: 400, error: { type: "invalid_request_error", message: "No such price" } }));
		const user = await signIn("stripe-error@example.com");
		const error = console.error;
		console.error = () => {};
		try {
			assert.equal(await as(user, () => catchRedirect(checkout())), "/billing?interval=year&error=stripe");
		} finally {
			console.error = error;
		}
	});

	test("sign-in goes on only to paths on this site, with at most a plain query string", () => {
		const { toSafeNextPath } = m.validation;
		assert.equal(toSafeNextPath(CHECKOUT), CHECKOUT);
		assert.equal(toSafeNextPath("/campaigns"), "/campaigns");
		for (const value of ["//evil.example", "https://evil.example", "/\\evil.example", "/billing?next=https://evil.example", "/a b", undefined, ["/x"]]) {
			assert.equal(toSafeNextPath(value), "/", String(value));
		}
	});

	test("plan buttons link to checkout with the plan and a billing period", () => {
		const { getCheckoutPath } = m.plans;
		assert.equal(getCheckoutPath("growth", "year"), CHECKOUT);
		assert.equal(getCheckoutPath("starter", "weekly"), "/billing/checkout?plan=starter&interval=month");
	});
});

describe("pricing", () => {
	test("the price per 1,000 emails is a month's price over the plan's emails, yearly plans spread over 12 months", () => {
		const { PLANS, getPricePerThousand } = m.plans;
		const perThousand = (interval) => PLANS.map((plan) => m.format.formatUsdCents(getPricePerThousand(plan, interval)));
		assert.deepEqual(perThousand("month"), ["$0.60", "$0.36", "$0.28", "$0.22", "$0.15"]);
		assert.deepEqual(perThousand("year"), ["$0.50", "$0.30", "$0.23", "$0.18", "$0.12"]);
	});
});

describe("copy", () => {
	test("the header and footer, the docs' share image, the plans slider and llms.txt never name an email provider", async () => {
		const files = ["app/(site)/opengraph-image.js", "components/HeaderSite.jsx", "components/FooterSite.jsx", "components/ListPricing.jsx", "components/SliderPricing.jsx", "lib/site.js"];
		for (const file of files) assert.doesNotMatch(await readFile(join(ROOT, file), "utf8"), PROVIDERS, file);

		const intro = m.docs.getLlmsIndex(SITE_URL).split("## Docs")[0];
		assert.match(intro, /^> The affordable newsletter for the agentic era: a newsletter app where you pay for the emails you send, not for dormant subscribers,/m);
		assert.doesNotMatch(intro, /autopilot/);
		assert.doesNotMatch(intro, PROVIDERS);
	});
});

describe("search engines", () => {
	test("the sitemap lists the marketing site's pages, then the docs", () => {
		const urls = withSiteUrl(() => m.sitemap()).map(({ url }) => url);
		const docs = m.docs.DOC_PAGES.map(({ href }) => `${SITE_URL}${href}`);
		assert.deepEqual(urls, [...m.siteExtensions.publicPages.map((path) => (path === "/" ? SITE_URL : `${SITE_URL}${path}`)), ...docs]);
	});

	test("robots.txt keeps crawlers out of every dashboard page, the admin and the APIs, and points at the sitemap", async () => {
		const { rules, sitemap } = withSiteUrl(() => m.robots());
		assert.equal(sitemap, `${SITE_URL}/sitemap.xml`);
		assert.equal(rules.userAgent, "*");
		assert.equal(rules.allow, "/");

		const folders = [];
		for (const group of ["app/(app)", "app/(account)"]) {
			const entries = await readdir(join(ROOT, group), { withFileTypes: true });
			folders.push(...entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("(")).map(({ name }) => `/${name}`));
		}
		assert.ok(folders.includes("/campaigns") && folders.includes("/billing"));
		for (const path of [...folders, "/admin", "/api/", "/mcp", "/welcome", "/oauth/"]) assert.ok(rules.disallow.includes(path), `${path} is crawlable`);

		// Sign-in stays crawlable, so search engines that follow the public pages' links to it read its noindex.
		const publicPaths = [...m.siteExtensions.publicPages, ...m.docs.DOC_PAGES.map(({ href }) => href), "/signin"];
		for (const path of publicPaths) {
			assert.ok(!rules.disallow.some((rule) => path.startsWith(rule)), `${path} is blocked`);
		}
	});

	test("public pages name their canonical URL", () => {
		assert.deepEqual(m.site.getPageMetadata({ title: "Errors", description: "Codes", path: "/docs/errors" }).alternates, { canonical: "/docs/errors" });
		assert.deepEqual(m.docs.getDocsPageMetadata("/docs/mcp").alternates, { canonical: "/docs/mcp" });
	});

	test("every public page has a title, a description and a canonical URL of its own", async () => {
		const paths = [...m.siteExtensions.publicPages, ...m.docs.DOC_PAGES.map(({ href }) => href)];
		const titles = new Set();
		const descriptions = new Set();
		for (const path of paths) {
			const { file, metadata } = await readPage(path);
			const title = await resolveTitle(file, metadata.title);
			assert.match(title, /FlockStack/, `${path}: ${title}`);
			assert.ok(metadata.description?.length >= 50 && metadata.description.length <= 200, `${path}: ${metadata.description}`);
			assert.equal(metadata.alternates?.canonical, path, path);
			// A page's openGraph would replace its layouts' whole: the share image and the page's address with it.
			assert.equal(metadata.openGraph, undefined, `${path} sets an openGraph of its own`);
			assert.doesNotMatch(`${title} ${metadata.description}`, PROVIDERS, path);
			titles.add(title);
			descriptions.add(metadata.description);
		}
		assert.equal(titles.size, paths.length, "two pages share a title");
		assert.equal(descriptions.size, paths.length, "two pages share a description");
	});

	test("public pages are indexed on the app's address, with large social cards that name each page", async () => {
		const { metadata } = await importFile("app/(site)/layout.js");
		assert.equal(metadata.metadataBase.href, new URL("/", m.config.getAppUrl()).href);
		assert.deepEqual(metadata.robots, { index: true, follow: true });
		assert.deepEqual(metadata.openGraph, { type: "website", siteName: "FlockStack", locale: "en_US", url: "./" });
		assert.equal(metadata.twitter.card, "summary_large_image");
		assert.deepEqual((await importFile("app/layout.js")).metadata.robots, { index: false, follow: false }, "the app's own pages stay out of search");
	});

	test("the sitemap lists public pages only, never one of the app's", async () => {
		const urls = await withEnv({ APP_URL: SITE_URL }, () => m.sitemap().map(({ url }) => url));
		const sitePages = await listSitePages();
		const appRoutes = await listAppRoutes();
		assert.ok(["/signin", "/admin", "/api/v1", "/campaigns", "/billing", "/welcome", "/archive"].every((route) => appRoutes.includes(route)), appRoutes.join());
		for (const url of urls) {
			const path = url === SITE_URL ? "/" : new URL(url).pathname;
			assert.ok(url === SITE_URL || url.startsWith(`${SITE_URL}/`), url);
			const renderedAt = path === "/" ? m.siteExtensions.landingPath : path;
			assert.ok(sitePages.some(({ pattern }) => pattern.test(renderedAt)), `${url} isn't a page of app/(site)`);
			assert.ok(!appRoutes.some((route) => path === route || path.startsWith(`${route}/`)), `${url} is one of the app's routes`);
			assert.deepEqual(outcome(await visit(path)), path === "/" ? { rewrite: renderedAt } : { next: true }, url);
		}
	});

	test("public pages link a web manifest with the app's icons at 192 and 512 pixels", async () => {
		assert.equal((await importFile("app/(site)/layout.js")).metadata.manifest, "/site.webmanifest");
		assert.deepEqual(outcome(await visit("/site.webmanifest")), { next: true });
		const response = (await importFile("app/site.webmanifest/route.js")).GET();
		assert.equal(response.headers.get("content-type"), "application/manifest+json");
		const manifest = await response.json();
		assert.equal(manifest.name, "FlockStack");
		assert.equal(manifest.start_url, "/");
		assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);
		for (const { src, sizes, type } of manifest.icons) {
			const png = await readFile(join(ROOT, "public", src));
			assert.equal(type, "image/png", src);
			assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, sizes, src);
		}
	});
});
