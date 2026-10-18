import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../next.config.mjs";
import { isTrackedPath } from "../lib/marketing/analytics-privacy.js";
import { activate, catchRedirect, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// Where FlockStack's PostHog loads: the layouts of FlockStack's own pages and nowhere else, and what each request gets.
// A reader or a newsletter's subscriber is never on a page that carries it (the first group scans every route).
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = "phc_exampleprojectkey0123456789";
const CLOUD = { POSTHOG_KEY: KEY, FLOCKSTACK_CLOUD: "true", FLOCKSTACK_REGION: "us" };

let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		extensions: await import("@/components/SiteExtensions"),
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		provider: await import("../components/marketing/ProviderAnalytics.jsx"),
		banner: await import("../components/marketing/BannerConsent.jsx"),
		footerCookies: await import("../components/marketing/FooterCookies.jsx"),
		layouts: {
			root: await import("../app/layout.js"),
			site: await import("../app/(site)/layout.js"),
			home: await import("../app/(site)/home/layout.js"),
			docs: await import("../app/(site)/docs/layout.js"),
			privacy: await import("../app/(site)/privacy/layout.js"),
			terms: await import("../app/(site)/terms/layout.js"),
			subProcessors: await import("../app/(site)/sub-processors/layout.js"),
		},
		welcome: await import("../app/welcome/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		signin: await import("../app/signin/actions.js"),
	};
});

after(() => app?.stop());

async function walk(dir) {
	const files = [];
	for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(path)));
		else files.push(path);
	}
	return files;
}

const read = (file) => readFile(join(ROOT, file), "utf8");
const rendersAnalytics = (source) => /<SiteAnalytics[\s/>]/.test(source);

// A page's address: route groups leave no trace in it, and a [slug] folder stands for any value.
function addressOf(dir) {
	const segments = dir.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
	return `/${segments.map((segment) => segment.replace(/^\[.*\]$/, "x")).join("/")}`;
}

// Every page under app/ with the layouts above it, and whether any of them (or the page) renders the analytics.
async function scanPages() {
	const files = (await walk("app")).map((file) => file.slice("app/".length));
	const sources = new Map();
	for (const file of files) if (/(^|\/)(layout|page)\.js$/.test(file)) sources.set(file, await read(`app/${file}`));
	const dashboard = rendersAnalytics(await read("components/LayoutDashboard.jsx"));
	const renders = (source) => rendersAnalytics(source) || (dashboard && /<LayoutDashboard[\s>]/.test(source));
	return [...sources.keys()]
		.filter((file) => file.endsWith("page.js"))
		.map((file) => {
			const dir = file.slice(0, -"page.js".length).replace(/\/$/, "");
			const chain = ["", ...dir.split("/").filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join("/"))];
			const carriers = [...chain.map((path) => (path ? `${path}/layout.js` : "layout.js")), file].filter((path) => sources.has(path) && renders(sources.get(path)));
			return { file: `app/${file}`, address: addressOf(dir), carriers };
		});
}

describe("which pages carry the analytics", () => {
	test("FlockStack's own pages do, and the root layout does not", async () => {
		const pages = await scanPages();
		const loads = (address) => {
			const page = pages.find((item) => item.address === address);
			assert.ok(page, `a page at ${address}`);
			return page.carriers.length > 0;
		};
		for (const address of ["/home", "/docs", "/docs/api", "/docs/regions", "/privacy", "/terms", "/sub-processors", "/signin", "/welcome", "/campaigns", "/contacts", "/newsletters", "/billing", "/account", "/api-keys", "/recommending"]) {
			assert.equal(loads(address), true, address);
		}
		assert.doesNotMatch(await read("app/layout.js"), /SiteAnalytics/);
	});

	test("a newsletter's pages, the pages readers use and the admin do not", async () => {
		const pages = await scanPages();
		const loads = (address) => {
			const matching = pages.filter((item) => item.address === address || item.address.startsWith(`${address}/`));
			assert.ok(matching.length > 0, `a page at ${address}`);
			return matching.filter((item) => item.carriers.length > 0).map((item) => item.file);
		};
		for (const address of ["/archive/x", "/recommendations", "/unsubscribe", "/confirm", "/keep", "/referral", "/reader/signin", "/reader/replies", "/admin", "/oauth/consent", "/restore"]) {
			assert.deepEqual(loads(address), [], address);
		}
	});

	test("the archive pages (shop, subscribe, comments and every issue) are all under app/archive, and none carries it", async () => {
		const pages = (await scanPages()).filter((item) => item.address.startsWith("/archive"));
		assert.ok(pages.length >= 5);
		for (const page of pages) assert.deepEqual(page.carriers, [], page.file);
	});

	test("every page agrees with the scrubber about whether it is tracked, so a route change can't carry PostHog into one that isn't", async () => {
		for (const { file, address, carriers } of await scanPages()) {
			const addresses = address === "/home" ? ["/", "/home"] : [address];
			for (const item of addresses) assert.equal(isTrackedPath(item), carriers.length > 0, `${file} (${item}) ${carriers.length > 0 ? "carries" : "doesn't carry"} it`);
		}
	});

	test("it is rendered from these files only, and the dashboard layout from the two dashboard layouts only", async () => {
		const carriers = [];
		const dashboardUsers = [];
		for (const dir of ["app", "components", "lib"]) {
			for (const file of (await walk(dir)).filter((name) => /\.(js|jsx)$/.test(name) && !name.includes("/marketing/"))) {
				const source = await read(file);
				if (rendersAnalytics(source)) carriers.push(file);
				if (/<LayoutDashboard[\s>]/.test(source)) dashboardUsers.push(file);
			}
		}
		assert.deepEqual(carriers.sort(), [
			"app/(site)/docs/layout.js",
			"app/(site)/home/layout.js",
			"app/(site)/privacy/layout.js",
			"app/(site)/sub-processors/layout.js",
			"app/(site)/terms/layout.js",
			"app/signin/page.js",
			"app/welcome/page.js",
			"components/LayoutDashboard.jsx",
		]);
		assert.deepEqual(dashboardUsers.sort(), ["app/(account)/layout.js", "app/(app)/layout.js"]);
	});

	test("the segment layouts render it, and the shared site layout, which holds the directory readers use, does not", () => {
		const hasAnalytics = (node) => {
			if (Array.isArray(node)) return node.some(hasAnalytics);
			if (!node || typeof node !== "object") return false;
			return node.type === m.extensions.SiteAnalytics || hasAnalytics(node.props?.children);
		};
		assert.equal(typeof m.extensions.SiteAnalytics, "function");
		for (const name of ["home", "docs", "privacy", "terms", "subProcessors"]) {
			assert.equal(hasAnalytics(m.layouts[name].default({ children: createElement("main") })), true, name);
		}
		assert.equal(hasAnalytics(m.layouts.site.default({ children: createElement("main") })), false);
		assert.equal(hasAnalytics(m.layouts.root.default({ children: createElement("main") })), false);
	});

	test("the open source's defaults add nothing", async () => {
		const source = await read("components/SiteExtensions.jsx");
		for (const name of ["SiteAnalytics", "FooterCookies", "SupportChat"]) assert.match(source, new RegExp(`export const ${name} = null;`));
		assert.match(await read("lib/site-extensions.js"), /supportChatPath: null,[\s\S]*supportAssistant: null,/);
	});
});

// The help chat (SupportChat) goes where the analytics goes, FlockStack's own pages, plus the newsletter setup page, and
// never on a newsletter's pages, the pages readers use, the shop or the admin.
describe("which pages carry the help chat", () => {
	const rendersChat = (source) => /<SupportChat[\s/>]/.test(source);

	async function scanChatPages() {
		const files = (await walk("app")).map((file) => file.slice("app/".length));
		const sources = new Map();
		for (const file of files) if (/(^|\/)(layout|page)\.js$/.test(file)) sources.set(file, await read(`app/${file}`));
		const dashboard = rendersChat(await read("components/LayoutDashboard.jsx"));
		const renders = (source) => rendersChat(source) || (dashboard && /<LayoutDashboard[\s>]/.test(source));
		return [...sources.keys()]
			.filter((file) => file.endsWith("page.js"))
			.map((file) => {
				const dir = file.slice(0, -"page.js".length).replace(/\/$/, "");
				const chain = ["", ...dir.split("/").filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join("/"))];
				const carriers = [...chain.map((path) => (path ? `${path}/layout.js` : "layout.js")), file].filter((path) => sources.has(path) && renders(sources.get(path)));
				return { file: `app/${file}`, address: addressOf(dir), carriers };
			});
	}

	test("FlockStack's own pages do: the home page, docs, legal pages, sign-in and the dashboard", async () => {
		const pages = await scanChatPages();
		for (const address of ["/home", "/docs", "/docs/api", "/docs/comments", "/privacy", "/terms", "/sub-processors", "/signin", "/welcome", "/campaigns", "/contacts", "/billing", "/account", "/api-keys"]) {
			const page = pages.find((item) => item.address === address);
			assert.ok(page?.carriers.length > 0, address);
		}
		assert.doesNotMatch(await read("app/layout.js"), /SupportChat/);
		assert.doesNotMatch(await read("app/(site)/layout.js"), /<SupportChat/);
	});

	test("a newsletter's pages, the pages readers use, the shop and the admin do not", async () => {
		const pages = await scanChatPages();
		for (const address of ["/archive/x", "/recommendations", "/unsubscribe", "/confirm", "/keep", "/referral", "/reader/signin", "/reader/replies", "/admin", "/oauth/consent", "/restore"]) {
			const matching = pages.filter((item) => item.address === address || item.address.startsWith(`${address}/`));
			assert.ok(matching.length > 0, `a page at ${address}`);
			assert.deepEqual(matching.filter((item) => item.carriers.length > 0).map((item) => item.file), [], address);
		}
		for (const page of pages.filter((item) => item.address.startsWith("/archive"))) assert.deepEqual(page.carriers, [], page.file);
	});

	test("every page with the chat is one the analytics may track, so neither reaches a reader", async () => {
		for (const { file, address, carriers } of await scanChatPages()) {
			if (carriers.length > 0) assert.equal(isTrackedPath(address === "/home" ? "/" : address), true, file);
		}
	});

	test("it is rendered from the analytics' files and the newsletter setup page only", async () => {
		const carriers = [];
		for (const dir of ["app", "components", "lib"]) {
			for (const file of (await walk(dir)).filter((name) => /\.(js|jsx)$/.test(name) && !name.includes("/marketing/"))) {
				if (rendersChat(await read(file))) carriers.push(file);
			}
		}
		assert.deepEqual(carriers.sort(), [
			"app/(site)/docs/layout.js",
			"app/(site)/home/layout.js",
			"app/(site)/privacy/layout.js",
			"app/(site)/sub-processors/layout.js",
			"app/(site)/terms/layout.js",
			"app/signin/page.js",
			"app/welcome/page.js",
			"components/LayoutDashboard.jsx",
		]);
	});
});

async function analyticsFor({ env = {}, headers = {}, jar = new Map(), user = null, account = null } = {}) {
	return withEnv({ ...CLOUD, ...env }, () =>
		runWithRequest({ jar, headers }, async () => {
			const element = m.extensions.SiteAnalytics({ user, account });
			return element ? element.type(element.props) : null;
		})
	);
}

describe("what a request gets", () => {
	test("with no key, nothing renders, and it doesn't wait for the request", async () => {
		for (const POSTHOG_KEY of ["", "nope"]) {
			assert.equal(await withEnv({ ...CLOUD, POSTHOG_KEY }, () => m.extensions.SiteAnalytics({})), null);
		}
		assert.equal(await analyticsFor({ env: { POSTHOG_KEY: "" } }), null);
	});

	test("a server that isn't FlockStack Cloud renders nothing", async () => {
		assert.equal(await withEnv({ ...CLOUD, FLOCKSTACK_CLOUD: "" }, () => m.extensions.SiteAnalytics({})), null);
	});

	test("a visitor outside the EU gets it on by default, with the US cloud's host and recording off", async () => {
		const element = await analyticsFor({ env: { LEGAL_PREVIEW: "true" }, headers: { "cf-ipcountry": "US" } });
		assert.equal(element.type, m.provider.default);
		assert.deepEqual(element.props, { token: KEY, host: "https://us.i.posthog.com", replay: false, region: "us", requiresConsent: false, consent: null, identity: null, privacyHref: "/privacy" });
	});

	test("the banner links the privacy policy only once the legal pages are published", async () => {
		const { getLegalTodos } = await import("../lib/legal.js");
		const element = await analyticsFor({ env: { LEGAL_PREVIEW: "" }, headers: { "cf-ipcountry": "US" } });
		assert.equal(element.props.privacyHref, getLegalTodos().length > 0 ? null : "/privacy");
	});

	test("a visitor in the EU, the UK or Switzerland, or on the EU deployment, is asked first", async () => {
		for (const country of ["DE", "GB", "CH", "NO"]) assert.equal((await analyticsFor({ headers: { "cf-ipcountry": country } })).props.requiresConsent, true, country);
		const eu = await analyticsFor({ env: { FLOCKSTACK_REGION: "eu" }, headers: { "cf-ipcountry": "US" } });
		assert.equal(eu.props.requiresConsent, true);
		assert.equal(eu.props.region, "eu");
		assert.equal((await analyticsFor({ headers: {} })).props.requiresConsent, true);
	});

	test("the saved choice reaches the browser", async () => {
		const accepted = await analyticsFor({ headers: { "cf-ipcountry": "DE" }, jar: new Map([["fs_consent", "accepted"]]) });
		assert.equal(accepted.props.consent, "accepted");
		const declined = await analyticsFor({ headers: { "cf-ipcountry": "US" }, jar: new Map([["fs_consent", "declined"]]) });
		assert.equal(declined.props.consent, "declined");
		const junk = await analyticsFor({ headers: { "cf-ipcountry": "US" }, jar: new Map([["fs_consent", "yes"]]) });
		assert.equal(junk.props.consent, null);
	});

	test("Global Privacy Control or Do Not Track renders nothing: no banner either", async () => {
		for (const headers of [{ "sec-gpc": "1" }, { dnt: "1" }, { "sec-gpc": "1", "cf-ipcountry": "DE" }, { dnt: "1", "cf-ipcountry": "US" }]) {
			assert.equal(await analyticsFor({ headers }), null, JSON.stringify(headers));
		}
		assert.equal(await analyticsFor({ headers: { "sec-gpc": "1" }, jar: new Map([["fs_consent", "accepted"]]) }), null);
		assert.ok(await analyticsFor({ headers: { "sec-gpc": "0", dnt: "0", "cf-ipcountry": "US" } }));
	});

	test("session recording follows POSTHOG_SESSION_REPLAY, and the host POSTHOG_HOST", async () => {
		const element = await analyticsFor({ env: { POSTHOG_SESSION_REPLAY: "true", POSTHOG_HOST: "https://eu.i.posthog.com" }, headers: { "cf-ipcountry": "US" } });
		assert.equal(element.props.replay, true);
		assert.equal(element.props.host, "https://eu.i.posthog.com");
	});

	test("a signed-in person is passed as an ID with their email and plan, and nothing else", async () => {
		const user = { id: "user_1", email: "ada@example.com", name: "Ada Lovelace", image: "https://example.com/ada.png" };
		const paying = await analyticsFor({ headers: { "cf-ipcountry": "US" }, user, account: { _id: "acct_1", subscriptionStatus: "active", plan: "starter", name: "Field notes" } });
		assert.deepEqual(paying.props.identity, { id: "user_1", email: "ada@example.com", plan: "starter" });
		const free = await analyticsFor({ headers: { "cf-ipcountry": "US" }, user, account: { _id: "acct_1" } });
		assert.deepEqual(free.props.identity, { id: "user_1", email: "ada@example.com", plan: "none" });
		assert.doesNotMatch(JSON.stringify(paying.props), /Ada Lovelace|Field notes|ada\.png|acct_1/);
	});

	test("the server-rendered page holds a marker and no script, no banner and no address of PostHog's", async () => {
		const element = await analyticsFor({ headers: { "cf-ipcountry": "DE" } });
		const markup = renderToStaticMarkup(createElement(element.type, element.props));
		assert.equal(markup, "<span hidden=\"\" data-analytics-provider=\"true\"></span>");
		assert.doesNotMatch(markup, /script|posthog|<section/i);
		assert.equal(renderToStaticMarkup(createElement(m.footerCookies.default, { className: "x" })), "");
	});
});

describe("the consent banner", () => {
	const render = (props = {}) => renderToStaticMarkup(createElement(m.banner.default, { onChoose() {}, onClose() {}, ...props }));
	const buttons = (markup) => [...markup.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attributes, label]) => ({ attributes, label }));
	const attribute = (attributes, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];

	test("is a labelled region with short sentence-case text and a link to the privacy policy once it is published", () => {
		assert.doesNotMatch(render(), /href=/);
		const markup = render({ privacyHref: "/privacy" });
		const labelledBy = attribute(markup, "aria-labelledby");
		const describedBy = attribute(markup, "aria-describedby");
		assert.match(markup, /<section\b[^>]*role="region"/);
		assert.match(markup, new RegExp(`<h2 id="${labelledBy}"[^>]*>Analytics on FlockStack&#x27;s own pages</h2>`));
		assert.match(markup, new RegExp(`<div id="${describedBy}"`));
		assert.match(markup, /<a href="\/privacy"[^>]*>Privacy policy<\/a>/);
		const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		assert.ok(text.length < 520, `${text.length} characters`);
		assert.match(text, /never runs on newsletters or on the pages readers use/);
		assert.doesNotMatch(markup, /cheap/i);
	});

	test("Accept and Decline are two buttons of the same style, size and place", () => {
		const [accept, decline, ...others] = buttons(render());
		assert.deepEqual([accept.label, decline.label], ["Accept", "Decline"]);
		assert.equal(others.length, 0);
		for (const name of ["class", "data-variant", "data-size", "type"]) assert.equal(attribute(accept.attributes, name), attribute(decline.attributes, name), name);
		assert.equal(attribute(accept.attributes, "type"), "button");
		assert.match(attribute(accept.attributes, "class"), /flex-1/);
		assert.equal(attribute(accept.attributes, "data-variant"), "outline");
	});

	test("fits a phone and loads nothing from anywhere", () => {
		const markup = render();
		assert.match(markup, /inset-x-3/);
		assert.match(markup, /sm:w-\[26rem\]/);
		assert.doesNotMatch(markup, /<script|<img|<iframe|<link|src=|https?:\/\//);
	});

	test("opened from the footer link it is a dialog that takes focus, says the current choice and can be closed", () => {
		const markup = render({ isSettings: true, consent: "accepted" });
		assert.match(markup, /<section\b[^>]*role="dialog"/);
		assert.match(markup, /aria-modal="false"/);
		assert.match(markup, /<h2\b[^>]*tabindex="-1"[^>]*>Cookie settings<\/h2>/);
		assert.match(markup, /You accepted analytics\./);
		assert.deepEqual(buttons(markup).map(({ label }) => label), ["Accept", "Decline", "Close"]);
		assert.match(render({ isSettings: true, consent: "declined" }), /You declined analytics\./);
		assert.match(render({ isSettings: true, consent: null, requiresConsent: false }), /Analytics is on, as it is where you are\./);
		assert.doesNotMatch(render({ consent: "accepted" }), /You accepted/);
	});

	test("the component reads Escape and the buttons as keyboard actions, with the footer link a real button", async () => {
		const source = await read("components/marketing/BannerConsent.jsx");
		assert.match(source, /event\.key === "Escape"/);
		assert.match(source, /headingRef\.current\?\.focus\(\)/);
		assert.match(await read("components/marketing/FooterCookies.jsx"), /<button type="button" onClick=\{openCookieSettings\}/);
		assert.match(await read("components/marketing/ProviderAnalytics.jsx"), /opener\.current\?\.focus\?\.\(\)/);
	});
});

describe("steps only the server sees", () => {
	const leave = (goal, { env = {}, headers = {}, jar = new Map() } = {}) =>
		withEnv({ ...CLOUD, ...env }, () => runWithRequest({ jar, headers }, async () => {
			await m.siteExtensions.sendGoalOnNextPage(goal);
			return jar.get("fs_goal") ?? null;
		}));

	test("leave their name in a cookie for the browser to report, for a visitor whose analytics is on", async () => {
		assert.equal(await leave("signup_completed", { headers: { "cf-ipcountry": "US" } }), "signup_completed");
		assert.equal(await leave("onboarding_completed", { headers: { "cf-ipcountry": "DE" }, jar: new Map([["fs_consent", "accepted"]]) }), "onboarding_completed");
		assert.equal(await leave("plan_started", { env: { FLOCKSTACK_REGION: "eu" }, jar: new Map([["fs_consent", "accepted"]]) }), "plan_started");
	});

	test("leave nothing for a visitor who hasn't accepted, has declined, or sends a privacy signal", async () => {
		assert.equal(await leave("signup_completed", { headers: { "cf-ipcountry": "DE" } }), null);
		assert.equal(await leave("signup_completed", { env: { FLOCKSTACK_REGION: "eu" }, headers: { "cf-ipcountry": "US" } }), null);
		assert.equal(await leave("signup_completed", { headers: { "cf-ipcountry": "US" }, jar: new Map([["fs_consent", "declined"]]) }), null);
		assert.equal(await leave("signup_completed", { headers: { "cf-ipcountry": "US", "sec-gpc": "1" } }), null);
		assert.equal(await leave("signup_completed", { headers: { "cf-ipcountry": "US", dnt: "1" }, jar: new Map([["fs_consent", "accepted"]]) }), null);
	});

	test("leave nothing without a key, for a step that isn't counted, or outside a request", async () => {
		assert.equal(await leave("signup_completed", { env: { POSTHOG_KEY: "" }, headers: { "cf-ipcountry": "US" } }), null);
		assert.equal(await leave("page_viewed", { headers: { "cf-ipcountry": "US" } }), null);
		const warn = console.warn;
		console.warn = () => {};
		try {
			await withEnv(CLOUD, () => assert.doesNotReject(m.siteExtensions.sendGoalOnNextPage("signup_completed")));
		} finally {
			console.warn = warn;
		}
	});

	test("a first sign-in, the first newsletter and a second one each leave theirs", async () => {
		await withEnv(CLOUD, async () => {
			const user = { email: "ada@example.com", jar: new Map([["fs_consent", "accepted"]]), ip: "198.51.100.77" };
			const run = (code) => runWithRequest({ jar: user.jar, headers: { "x-forwarded-for": user.ip, "cf-ipcountry": "US" } }, code);
			await run(() => m.signin.sendSigninCode(null, form({ email: user.email })));
			const code = platformEmails.findLast(({ to }) => to.includes(user.email)).subject.slice(0, 6);
			await run(() => catchRedirect(m.signin.verifySigninCode(null, form({ email: user.email, code, next: "/" }))));
			assert.equal(user.jar.get("fs_goal"), "signup_completed");

			user.jar.delete("fs_goal");
			await run(() => catchRedirect(m.welcome.completeOnboarding(null, form({ name: "Field notes" }))));
			assert.equal(user.jar.get("fs_goal"), "onboarding_completed");

			user.jar.delete("fs_goal");
			const stored = await (await import("../models/Account.js")).default.findOne({}).lean();
			await activate({ accountId: stored._id });
			await run(() => catchRedirect(m.newsletters.createNewsletter(null, form({ name: "Second issue" }))));
			assert.equal(user.jar.get("fs_goal"), "newsletter_created");
		});
	});

	test("sign-in leaves nothing for a visitor who must accept first and hasn't", async () => {
		await withEnv(CLOUD, async () => {
			const user = await signIn("grace@example.com");
			assert.equal(user.jar.has("fs_goal"), false);
		});
	});
});

describe("the security headers", () => {
	test("allow PostHog nowhere in particular: the policy restricts no script or connection, so nothing needs opening, and a newsletter's page can't be given PostHog by it", async () => {
		const [rule] = await nextConfig.headers();
		const policy = rule.headers.find(({ key }) => key === "Content-Security-Policy").value;
		assert.doesNotMatch(policy, /posthog/i);
		const directives = policy.split(";").map((directive) => directive.trim().split(/\s+/)[0]);
		for (const name of ["default-src", "script-src", "connect-src", "img-src"]) assert.ok(!directives.includes(name), `${name} would need PostHog's host on the pages that load it`);
	});
});
