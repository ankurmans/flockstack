import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { getLegalTodos } from "../lib/legal.js";
import { startTestApp, withEnv } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// /terms, /privacy and /sub-processors: that they render, link to each other, read the company's choices from
// lib/legal.js, say what the code does (the limits, the retention, the regions), are registered like other public pages,
// and are linked from the footer and the sign-in page, on FlockStack Cloud only. Their content is read with
// LEGAL_PREVIEW=true; without it, a placeholder left in lib/legal.js hides them everywhere.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PAGES = ["terms", "privacy", "sub-processors"];

let app;
let m;

const textOf = (markup) =>
	markup
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");
const hrefsOf = (markup) => [...markup.matchAll(/<a [^>]*?href="([^"]*)"/g)].map(([, href]) => href.replaceAll("&amp;", "&"));
const render = (element) => renderToStaticMarkup(createElement(TooltipProvider, null, element));
const renderPage = (name) => render(m.pages[name].default());
const renderSignin = (env = {}) =>
	withEnv(env, () => runWithRequest({ jar: new Map(), headers: {} }, async () => renderToStaticMarkup(await m.signin.default({ searchParams: Promise.resolve({}) }))));

function visit(path) {
	const request = new m.NextRequest(new URL(path, "http://localhost:3000"), { headers: { host: "localhost:3000" } });
	return m.proxy(request);
}

before(async () => {
	process.env.LEGAL_PREVIEW = "true";
	app = await startTestApp();
	m = {
		legal: await import("../lib/legal.js"),
		subprocessors: await import("../lib/subprocessors.js"),
		config: await import("../lib/config.js"),
		docs: await import("../lib/docs/llms.js"),
		sitemap: (await import("../app/sitemap.js")).default,
		robots: (await import("../app/robots.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		signin: await import("../app/signin/page.js"),
		corpus: await import("../lib/marketing/support-corpus.js"),
		banner: await import("../components/marketing/BannerConsent.jsx"),
		footer: await import("../components/FooterSite.jsx"),
		pages: Object.fromEntries(await Promise.all(PAGES.map(async (name) => [name, await import(`../app/(site)/${name}/page.js`)]))),
	};
});

after(() => {
	delete process.env.LEGAL_PREVIEW;
	return app?.stop();
});

describe("the legal pages", () => {
	test("render, with their title, the effective date and the links between the three", async () => {
		const titles = { terms: "Terms of service", privacy: "Privacy policy", "sub-processors": "Sub-processors" };
		for (const name of PAGES) {
			const markup = renderPage(name);
			assert.match(markup, new RegExp(`<h1[^>]*>${titles[name]}</h1>`), name);
			assert.ok(textOf(markup).includes(`Effective ${m.legal.EFFECTIVE_DATE}`), name);
			const hrefs = hrefsOf(markup);
			for (const other of PAGES.filter((page) => page !== name)) assert.ok(hrefs.includes(`/${other}`), `${name} links to ${other}`);
		}
	});

	test("read the company's choices from lib/legal.js and have no placeholders of their own", async () => {
		const terms = textOf(renderPage("terms"));
		for (const value of [m.legal.OPERATOR_DESCRIPTION, m.legal.GOVERNING_LAW, m.legal.LIABILITY_CAP, m.legal.TERMS_CHANGE_NOTICE, String(m.legal.MINIMUM_AGE), m.legal.TAX_NOTE]) {
			assert.ok(terms.includes(value), value);
		}
		assert.ok(terms.includes(`${m.legal.PRICE_INCREASE_NOTICE_DAYS} days`));
		assert.ok(terms.includes(`within ${m.legal.YEARLY_REFUND_DAYS} days of buying`));
		const privacy = textOf(renderPage("privacy"));
		for (const value of [m.legal.PRIVACY_EMAIL, m.legal.LOG_RETENTION, m.legal.BACKUP_RETENTION, m.legal.PRIVACY_REQUEST_RESPONSE, m.legal.ANALYTICS_RULE, m.legal.ANALYTICS_RETENTION, m.legal.SUPPORT_CHAT_STORED, m.legal.SUPPORT_CHAT_RETENTION, m.legal.TERMS_CHANGE_NOTICE]) {
			assert.ok(privacy.includes(value), value);
		}
		for (const { name, text, source } of m.legal.TRANSFER_SAFEGUARDS) assert.ok(privacy.includes(text) && privacy.includes(name), name);
		assert.ok(!privacy.includes(m.legal.SERVICES_LIVE_CONFIRMED), "the publish gate is not page text");
		const processors = textOf(renderPage("sub-processors"));
		for (const value of [m.legal.PRIVACY_EMAIL, m.legal.OPTIONAL_SERVICES_IN_USE, m.legal.SUBPROCESSOR_CHANGE_NOTICE]) assert.ok(processors.includes(value), value);

		for (const file of ["terms", "privacy", "sub-processors"].map((name) => `app/(site)/${name}/page.js`).concat("components/LayoutLegal.jsx", "lib/subprocessors.js")) {
			const source = await readFile(join(ROOT, file), "utf8");
			assert.doesNotMatch(source, /TODO/, file);
		}
		for (const file of ["terms", "privacy", "sub-processors"].map((name) => `app/(site)/${name}/page.js`)) {
			assert.match(await readFile(join(ROOT, file), "utf8"), /from "@\/lib\/legal"/, file);
		}
	});

	test("carry the owner's answers", async () => {
		assert.equal(m.legal.GOVERNING_LAW, "the State of Wyoming, United States");
		assert.equal(m.legal.YEARLY_REFUND_DAYS, 30);
		assert.equal(m.legal.PRICE_INCREASE_NOTICE_DAYS, 90);
		assert.equal(m.legal.OPERATOR_DESCRIPTION, "KMF Ventures LLC, a Wyoming limited liability company");
		assert.equal(m.legal.MINIMUM_AGE, 16);
		assert.equal(m.legal.CHANGE_NOTICE_DAYS, 30);
		assert.match(m.legal.TERMS_CHANGE_NOTICE, /at least 30 days/);
		assert.match(m.legal.SUBPROCESSOR_CHANGE_NOTICE, /at least 30 days/);
		assert.match(m.legal.TAX_NOTE, /Polar is the merchant of record/);
		assert.match(m.legal.TAX_NOTE, /you are responsible for the tax on what you sell/);
		assert.match(m.legal.PRIVACY_REQUEST_RESPONSE, /within 30 days/);
		assert.match(m.legal.LOG_RETENTION, /7 days/);
		assert.match(m.legal.BACKUP_RETENTION, /30 days/);
	});

	test("every provider with a transfer safeguard is a sub-processor, and each safeguard names its source", () => {
		const names = [...m.subprocessors.SUBPROCESSORS, ...m.subprocessors.OPTIONAL_SUBPROCESSORS].map(({ name }) => name).join(" | ");
		for (const { name, text, source } of m.legal.TRANSFER_SAFEGUARDS) {
			assert.ok(names.includes(name === "Amazon Web Services" ? "Amazon SES" : name), name);
			assert.match(source, /^https:\/\//, name);
			assert.ok(text.length > 40, name);
			assert.doesNotMatch(text, /^TODO/);
		}
		assert.deepEqual(m.legal.TRANSFER_SAFEGUARDS.map(({ name }) => name), ["Cloudflare", "Amazon Web Services", "Upstash", "Polar", "Stripe", "PostHog", "Google"]);
	});

	test("the pages describe the analytics, the support assistant and Google sign-in as they will be live", () => {
		const privacy = textOf(renderPage("privacy"));
		const processors = textOf(renderPage("sub-processors"));
		for (const phrase of [
			"PostHog",
			"never on a newsletter's public pages or on the pages readers use",
			"One PostHog project, on PostHog US Cloud, serves both flockstack.io and eu.flockstack.io",
			"it runs only after you accept if you are in the EU, the EEA, the UK or Switzerland, or on eu.flockstack.io",
			"A Global Privacy Control or Do Not Track signal from your browser turns it off",
			"Session recording is off",
			"user ID, email address and plan",
			"fs_consent",
			"Cookie settings",
			"Cloudflare Workers AI",
			"may be processed outside your region",
			"fs_reader_<newsletter>",
			"Recommendations:",
			"Comments:",
			"Deleted reader",
		]) {
			assert.ok(privacy.includes(phrase), phrase);
		}
		assert.doesNotMatch(privacy, /nothing for advertising or analytics/);
		for (const phrase of ["PostHog US Cloud", "One PostHog project serves both flockstack.io and eu.flockstack.io", "events from eu.flockstack.io are processed in the United States", "runs only after the visitor accepts", "Workers AI runs on Cloudflare's global network", "Google (sign-in)", "Google receives the sign-in request and the person's choice to sign in", m.legal.OPTIONAL_SERVICES_IN_USE]) {
			assert.ok(processors.includes(phrase), phrase);
		}
		assert.doesNotMatch(processors + privacy, /EU-only|only in the EU/i);
		assert.doesNotMatch(processors + privacy, /PostHog EU Cloud/);
	});

	test("the terms give the limits the code uses, the refund rules and the promises", () => {
		const { pause, block } = m.config.LIMITS;
		const text = textOf(renderPage("terms"));
		assert.match(text, /past 2% hard bounces \(at least 5\) or 0\.08% complaints \(at least 2\)/);
		assert.match(text, /past 5% hard bounces \(at least 10\) or 0\.3% complaints \(at least 3\)/);
		assert.deepEqual([pause.bounceRate, pause.complaintRate, block.bounceRate, block.complaintRate], [0.02, 0.0008, 0.05, 0.003]);
		for (const phrase of [
			"We always tell you why",
			"you keep access through the end of the period you already paid for",
			"We don't refund the current month",
			"pro rata",
			"0% of what you sell",
			"Stripe's own processing fees apply",
			"export everything, free, at any time",
			"It works even if your account is blocked, paused or has no plan",
			"AGPL-3.0",
			"You are the controller of your subscribers' personal data, and FlockStack is your processor",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
	});

	test("the privacy policy covers what is collected, what isn't done, retention, rights, readers and cookies", () => {
		const text = textOf(renderPage("privacy"));
		for (const phrase of [
			"IP address and browser",
			"No advertising",
			"selling or renting",
			"30 days",
			"keyed hash of the owner's email address",
			"The records of emails already sent to the address",
			"If you are a creator's subscriber, the creator is the one to ask",
			"unsubscribe link",
			"better-auth.session_token",
			"flockstack-eu.session_token",
			"region",
			"tz",
			"Data stored in the EU is the most we say",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
		assert.doesNotMatch(text, /EU[- ]resident/i);
	});

	test("the sub-processors table lists every service with its regions, optional ones apart", () => {
		const text = textOf(renderPage("sub-processors"));
		const names = [...m.subprocessors.SUBPROCESSORS, ...m.subprocessors.OPTIONAL_SUBPROCESSORS].map(({ name }) => name);
		assert.deepEqual(names, ["Cloudflare", "Amazon SES (Amazon Web Services)", "Upstash QStash", "Polar", "Stripe", "PostHog", "Google (sign-in)", "Google Postmaster Tools", "Telegram", "Upstash Redis", "Vercel"]);
		for (const { name, purpose, us, eu, link } of [...m.subprocessors.SUBPROCESSORS, ...m.subprocessors.OPTIONAL_SUBPROCESSORS]) {
			assert.ok(text.includes(name) && text.includes(purpose) && text.includes(us) && text.includes(eu), name);
			assert.match(link, /^https:\/\//, name);
		}
		for (const phrase of ["Amazon SES in us-east-2", "Amazon SES in eu-west-1", "QStash in its US region", "QStash in its EU region", "EU jurisdiction", "off unless", "data processing agreement (DPA) on request", "processor"]) {
			assert.ok(text.includes(phrase), phrase);
		}
		assert.equal(m.legal.SES_REGIONS.us, "us-east-2");
		assert.ok(hrefsOf(renderPage("sub-processors")).includes("mailto:hello@flockstack.io"));
	});

	test("the regions facts agree with the sub-processors", async () => {
		const regions = await import("../lib/docs/regions.js");
		const sending = regions.REGION_DATA.find(({ what }) => what.startsWith("Sending"));
		assert.match(sending.us, /us-east-2/);
		assert.match(sending.eu, /eu-west-1/);
	});
});

describe("lib/legal.js and the check", () => {
	test("getLegalTodos lists the values that start with TODO:", () => {
		assert.deepEqual(m.legal.getLegalTodos({ a: "TODO: x", b: "done", c: "", d: 90 }), [["a", "TODO: x"]]);
		assert.deepEqual(m.legal.getLegalTodos({ a: "ok" }), []);
	});

	test("scripts/check-legal.mjs names each placeholder left, and exits 1 while there are any", () => {
		const result = spawnSync("node", ["scripts/check-legal.mjs"], { cwd: ROOT, encoding: "utf8" });
		const todos = m.legal.getLegalTodos();
		assert.equal(result.status, todos.length > 0 ? 1 : 0);
		for (const [name] of todos) assert.ok(result.stderr.includes(name), name);
		assert.ok(todos.some(([name]) => name === "EFFECTIVE_DATE") || todos.length === 0);
	});

	test("the owner's answered questions are no longer placeholders, and what is open is exactly this", () => {
		const names = m.legal.getLegalTodos().map(([name]) => name);
		for (const name of ["GOVERNING_LAW", "OPERATOR_DESCRIPTION", "PRIVACY_EMAIL", "TERMS_CHANGE_NOTICE", "MINIMUM_AGE", "TAX_NOTE", "PRIVACY_REQUEST_RESPONSE", "LOG_RETENTION", "BACKUP_RETENTION", "SUBPROCESSOR_CHANGE_NOTICE", "OPTIONAL_SERVICES_IN_USE", "LIABILITY_CAP"]) assert.ok(!names.includes(name), name);
		// Not asserting equality once the owner fills them: each is a placeholder or has been filled in.
		for (const name of ["EFFECTIVE_DATE", "SUPPORT_CHAT_STORED", "SUPPORT_CHAT_RETENTION", "ANALYTICS_RETENTION", "SERVICES_LIVE_CONFIRMED"]) assert.ok(name in m.legal, name);
		assert.ok(!("OPERATOR_ADDRESS" in m.legal));
		assert.ok(!("EU_REPRESENTATIVE" in m.legal) && !("DPO_CONTACT" in m.legal));
	});

	test("isLegalPublished: once nothing is left, or with LEGAL_PREVIEW=true, read when called", async () => {
		const hasTodos = m.legal.getLegalTodos().length > 0;
		await withEnv({ LEGAL_PREVIEW: "" }, () => {
			assert.equal(m.legal.isLegalPublished(), !hasTodos);
			assert.deepEqual(m.legal.getPublishedLegalPages(), hasTodos ? [] : m.legal.LEGAL_PAGES);
		});
		await withEnv({ LEGAL_PREVIEW: "true" }, () => {
			assert.equal(m.legal.isLegalPublished(), true);
			assert.deepEqual(m.legal.getPublishedLegalPages(), m.legal.LEGAL_PAGES);
		});
	});

	test("the deploy script lists what is left and deploys anyway; the README says so", async () => {
		const script = await readFile(join(ROOT, "scripts/deploy-all.mjs"), "utf8");
		assert.match(script, /getLegalTodos/);
		assert.doesNotMatch(script, /allow-legal-todos/);
		const readme = await readFile(join(ROOT, "README.md"), "utf8");
		assert.match(readme, /node scripts\/check-legal\.mjs/);
		assert.doesNotMatch(readme, /allow-legal-todos/);
	});
});

describe("registration on FlockStack Cloud", () => {
	test("the pages open without a session, are in the sitemap and llms.txt, and robots.txt leaves them open", async () => {
		for (const path of m.legal.LEGAL_PATHS) {
			assert.ok(m.siteExtensions.publicPages.includes(path), path);
			const response = await visit(path);
			assert.ok(response.headers.get("x-middleware-next"), path);
		}
		const urls = await withEnv({ APP_URL: "https://flockstack.io" }, () => m.sitemap().map(({ url }) => url));
		for (const path of m.legal.LEGAL_PATHS) assert.ok(urls.includes(`https://flockstack.io${path}`), path);
		const { rules } = m.robots();
		for (const path of m.legal.LEGAL_PATHS) assert.ok(!rules.disallow.some((rule) => path.startsWith(rule)), path);
		const index = m.docs.getLlmsIndex("https://flockstack.io");
		assert.match(index, /## Legal/);
		for (const { href, title } of m.legal.LEGAL_PAGES) assert.ok(index.includes(`[${title}](https://flockstack.io${href})`), href);
	});

	test("the footer links Terms, Privacy and Sub-processors", () => {
		const markup = render(m.footer.default());
		const nav = /<nav aria-label="Legal">[\s\S]*?<\/nav>/.exec(markup)?.[0] ?? "";
		assert.deepEqual(hrefsOf(nav), ["/terms", "/privacy", "/sub-processors"]);
		assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map(([, label]) => label), ["Terms", "Privacy", "Sub-processors"]);
	});

	test("sign-in says that continuing agrees to the terms and the privacy policy, and links all three pages", async () => {
		const markup = await renderSignin();
		assert.match(textOf(markup), /By continuing you agree to the Terms and Privacy Policy\s*\./);
		const hrefs = hrefsOf(markup);
		for (const path of m.legal.LEGAL_PATHS) assert.ok(hrefs.includes(path), path);
		assert.match(markup, /<a [^>]*href="\/terms"[^>]*>Terms<\/a>[\s\S]*<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
	});
});

describe("a self-hosted server", () => {
	test("has none of it: 404 for the pages, nothing in the sitemap, llms.txt, footer or sign-in", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => {
			for (const path of m.legal.LEGAL_PATHS) {
				const response = await visit(path);
				assert.equal(new URL(response.headers.get("x-middleware-rewrite")).pathname, "/_not-on-this-server", path);
			}
			const urls = m.sitemap().map(({ url }) => url);
			assert.ok(!urls.some((url) => m.legal.LEGAL_PATHS.some((path) => url.endsWith(path))));
			assert.doesNotMatch(m.docs.getLlmsIndex("https://example.com"), /## Legal/);
			assert.doesNotMatch(render(m.footer.default()), /\/terms/);
		});
		const markup = await renderSignin({ FLOCKSTACK_CLOUD: "" });
		assert.doesNotMatch(markup, /By continuing you agree/);
		assert.ok(!hrefsOf(markup).includes("/terms"));
	});
});

describe("while lib/legal.js has a placeholder left", () => {
	const hasTodos = getLegalTodos().length > 0;
	const hidden = (run) => withEnv({ LEGAL_PREVIEW: "" }, run);

	test("the pages answer 404, signed out or in", { skip: !hasTodos && "no placeholder left" }, async () => {
		await hidden(async () => {
			const { NotFoundError } = await import("./stubs/next-navigation.mjs");
			for (const name of PAGES) assert.throws(() => m.pages[name].default(), NotFoundError, name);
			for (const path of m.legal.LEGAL_PATHS) {
				const response = await visit(path);
				assert.ok(response.headers.get("x-middleware-next"), `${path} reaches the page, not the sign-in`);
			}
		});
	});

	test("nothing links to them: footer, sitemap, llms.txt, sign-in, the consent banner and the support assistant", { skip: !hasTodos && "no placeholder left" }, async () => {
		await hidden(async () => {
			const isLegal = (href) => m.legal.LEGAL_PATHS.includes(new URL(href, "https://flockstack.io").pathname);
			for (const path of m.legal.LEGAL_PATHS) assert.ok(!m.siteExtensions.publicPages.includes(path), path);
			assert.deepEqual(m.siteExtensions.footer.legal, []);
			const footer = render(m.footer.default());
			assert.ok(!hrefsOf(footer).some(isLegal), "footer");
			const urls = await withEnv({ APP_URL: "https://flockstack.io" }, () => m.sitemap().map(({ url }) => url));
			assert.ok(!urls.some(isLegal), "sitemap");
			const index = m.docs.getLlmsIndex("https://flockstack.io");
			assert.doesNotMatch(index, /## Legal/);
			for (const path of m.legal.LEGAL_PATHS) assert.ok(!index.includes(`https://flockstack.io${path})`), path);
			const signin = await renderSignin();
			assert.doesNotMatch(signin, /By continuing you agree/);
			assert.ok(!hrefsOf(signin).some(isLegal), "sign-in");
			assert.ok(!hrefsOf(renderToStaticMarkup(createElement(m.banner.default, { onChoose() {}, onClose() {} }))).some(isLegal), "consent banner");
			const chunks = await withEnv({ APP_URL: "http://localhost:3000" }, () => m.corpus.buildChunks("http://localhost:3000"));
			assert.ok(chunks.length > 0);
			assert.ok(!chunks.some(({ href }) => isLegal(href)), "support corpus");
			assert.ok(!chunks.some(({ text }) => /TODO:/.test(text)), "no placeholder text for the assistant");
		});
	});
});
