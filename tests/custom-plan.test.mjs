import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, catchNotFound, startTestApp, withEnv } from "./helpers/app.mjs";

// The Custom plan gauges interest: it appears after Max on every pricing surface and says only what is true today. Nothing
// here may claim SOC 2, SSO, audit logs, SLAs or seats, which FlockStack doesn't have.
const APP_URL = "http://localhost:3000";
let app;
let m;

const textOf = (markup) =>
	markup
		.replace(/<script[\s\S]*?<\/script>/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;|&apos;/g, "'")
		.replace(/\s+/g, " ");

async function prerender(element) {
	const { prelude } = await prerenderToNodeStream(element);
	let html = "";
	for await (const chunk of prelude) html += chunk;
	return html.replaceAll("<!-- -->", "");
}

const slider = (props) => prerender(createElement(m.SliderPricing, { ...m.pricing.getPricing("growth", m.plans.PLANS), ...props }));

function visit(path) {
	return m.proxy(new m.NextRequest(new URL(path, APP_URL), { headers: { host: "localhost:3000" } }));
}

before(async () => {
	app = await startTestApp();
	m = {
		plans: await import("../lib/plans.js"),
		pricing: await import("../lib/pricing.js"),
		tier: await import("../lib/custom-tier.js"),
		choices: await import("../lib/custom-choices.js"),
		faq: await import("../lib/site-faq.js"),
		corpus: await import("../lib/marketing/support-corpus.js"),
		search: await import("../lib/marketing/support-search.js"),
		page: await import("../app/(site)/custom/page.js"),
		SliderPricing: (await import("../components/SliderPricing.jsx")).default,
		sitemap: (await import("../app/sitemap.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
	};
});

after(() => app?.stop());

describe("the Custom card", () => {
	test("is a step after Max, whose limits it starts from", async () => {
		const html = await slider({});
		const labels = [...html.matchAll(/aria-label="([^"]*emails a month)"/g)].map(([, label]) => label);
		assert.deepEqual(labels, ["10,000 emails a month", "25,000 emails a month", "125,000 emails a month", "250,000 emails a month", "500,000 emails a month", "2,000,000 emails a month", "Custom plan, over 2,000,000 emails a month"]);
		assert.match(html, /type="range"[^>]*max="6"/);
		assert.equal(m.pricing.getPricing("growth", m.plans.PLANS).plans.length, 5, "the five plans stay five");
	});

	test("says what it has today: limits beyond Max, a dedicated IP, migration help and a direct line", async () => {
		const html = await slider({ initialIndex: 6 });
		const text = textOf(html);
		for (const phrase of [
			"Custom",
			"Let's talk",
			"Over 2,000,000",
			"lists with over 400,000 subscribers",
			"Limits beyond Max: over 400,000 subscribers or 2,000,000 emails a month",
			"A dedicated IP included",
			"Migration help from beehiiv, Substack and others",
			"A direct line to the people who build FlockStack",
			"We reply personally within 2 business days.",
			"Tell us what you need",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
		assert.match(html, /href="\/custom"[^>]*>Tell us what you need/);
		assert.doesNotMatch(text, /per 1,000 emails|Billed monthly|Every plan includes|Subscribe/, "no price, no checkout");
	});

	test("never claims SOC 2, SSO, audit logs, SLAs or seats", async () => {
		const plan = m.tier.getCustomPlan();
		assert.doesNotMatch(JSON.stringify(plan), m.tier.CUSTOM_UNAVAILABLE);
		assert.doesNotMatch(textOf(await slider({ initialIndex: 6 })), m.tier.CUSTOM_UNAVAILABLE);
	});

	test("on the billing page its button is a link to the form, never a plan switch", async () => {
		const html = await slider({ initialIndex: 6, current: { plan: "pro", interval: "month" }, action: async () => {} });
		assert.match(html, /href="\/custom"/);
		assert.doesNotMatch(html, /name="plan" value="custom"/);
		assert.doesNotMatch(html, /Current plan/);
		const onPro = await slider({ initialIndex: 3, current: { plan: "pro", interval: "month" }, action: async () => {} });
		assert.match(onPro, /name="plan" value="pro"/, "plans still switch");
	});
});

describe("the FAQ and the support assistant", () => {
	test("the FAQ answers 'Do you offer SOC 2, SSO or a custom plan?' honestly", () => {
		const entry = m.faq.FAQ.find(({ question }) => question === "Do you offer SOC 2, SSO or a custom plan?");
		assert.ok(entry);
		const answer = entry.answer.join(" ");
		assert.match(answer, /A custom plan, yes/);
		assert.match(answer, /FlockStack doesn't have a SOC 2 report or single sign-on yet/);
		assert.doesNotMatch(answer, /we are SOC ?2|SOC ?2[- ]compliant|SOC ?2 certified|we offer SSO/i);
		assert.deepEqual(entry.link, { href: "/custom", label: "Tell us what you need" });
	});

	test("the corpus has the Custom plan and what FlockStack lacks, and a question about SOC 2 finds it", async () => {
		const chunks = await withEnv({ FLOCKSTACK_CLOUD: "true", APP_URL, LEGAL_PREVIEW: "true" }, () => m.corpus.buildChunks(APP_URL));
		const custom = chunks.find(({ title }) => title === "Custom plan");
		assert.equal(custom.href, "/custom");
		assert.ok(custom.text.includes(m.tier.CUSTOM_NOT_YET));
		assert.match(custom.text, /never say it does/);
		const pricing = chunks.filter(({ href }) => href === "/pricing").map(({ text }) => text).join("\n");
		assert.match(pricing, /the Custom plan, "Let's talk"/);
		assert.doesNotMatch(pricing, /Sending more than .* ask support/);

		const index = await withEnv({ FLOCKSTACK_CLOUD: "true", APP_URL, LEGAL_PREVIEW: "true" }, () => m.corpus.getSupportIndex(APP_URL));
		for (const question of ["Do you have SOC 2?", "Is there SSO or SAML?", "Do you have an enterprise plan for a huge list?"]) {
			const found = m.search.search(index, question, { limit: 3 }).map(({ chunk }) => chunk.title);
			assert.ok(found.some((title) => title === "Custom plan" || title === "FAQ: Do you offer SOC 2, SSO or a custom plan?"), `${question} found ${found.join(" | ")}`);
		}
	});

	test("a self-hosted server's corpus has no Custom plan", async () => {
		const chunks = await withEnv({ FLOCKSTACK_CLOUD: "", APP_URL, LEGAL_PREVIEW: "true" }, () => m.corpus.buildChunks(APP_URL));
		assert.ok(!chunks.some(({ title, href }) => title === "Custom plan" || href === "/custom"));
	});
});

describe("the /custom page", () => {
	const render = () => renderToStaticMarkup(m.page.default());

	test("opens without a session and is in the sitemap", async () => {
		assert.ok(m.siteExtensions.publicPages.includes("/custom"));
		const response = await visit("/custom");
		assert.ok(response.headers.get("x-middleware-next"), "no redirect to sign-in");
		assert.ok(m.sitemap().some(({ url }) => url === `${APP_URL}/custom`));
	});

	test("says plainly that FlockStack has no SOC 2 or SSO yet, and claims nothing else", () => {
		const html = render();
		const notYet = /<p data-not-yet[^>]*>([\s\S]*?)<\/p>/.exec(html)[1];
		assert.match(textOf(notYet), /FlockStack doesn't have SOC 2, SSO or SAML, SCIM, audit logs, an uptime SLA and team seats with roles yet\./);
		assert.match(textOf(notYet), /tell us which ones you would need and we'll build the right ones first/);
		const claims = textOf(html.replace(/<form[\s\S]*<\/form>/, "").replace(notYet, ""));
		assert.doesNotMatch(claims, m.tier.CUSTOM_UNAVAILABLE);
		for (const phrase of ["Tell us what you need", "A dedicated IP included", "Migration help from beehiiv, Substack and others", "within 2 business days"]) {
			assert.ok(textOf(html).includes(phrase), phrase);
		}
	});

	test("has the form: every field and choice, a honeypot, and nothing sent to another site", () => {
		const html = render();
		for (const name of ["name", "email", "company", "website", "platform", "subscribers", "emailsPerMonth", "timeline", "message", "fax"]) {
			assert.match(html, new RegExp(`name="${name}"`), name);
		}
		for (const { id, label } of [...m.choices.CUSTOM_NEEDS, ...m.choices.CUSTOM_PLATFORMS, ...m.choices.CUSTOM_TIMELINES, ...m.choices.CUSTOM_SUBSCRIBER_RANGES, ...m.choices.CUSTOM_EMAIL_RANGES]) {
			assert.match(html, new RegExp(`value="${id}"`), id);
			assert.ok(textOf(html).includes(label), label);
		}
		assert.deepEqual(m.choices.CUSTOM_PLATFORMS.map(({ id }) => id), ["beehiiv", "substack", "mailchimp", "kit", "ghost", "wordpress", "other"]);
		assert.equal(m.choices.CUSTOM_NEEDS.length, 14);
		assert.match(html, /name="email"[^>]*type="email"|type="email"[^>]*name="email"/);
		assert.match(html, /<input type="text" name="fax" tabindex="-1" autoComplete="off"|name="fax"/);
		assert.doesNotMatch(html, /<form[^>]*action="https?:/);
		assert.doesNotMatch(html, /<form[^>]*method="get"/i, "a form that put the email in a URL");
	});

	test("works signed in or out, in both regions, and is absent from a self-hosted server", async () => {
		for (const FLOCKSTACK_REGION of ["us", "eu"]) {
			await withEnv({ FLOCKSTACK_REGION }, async () => assert.match(textOf(await anonymous(async () => render())), /Tell us what you need/));
		}
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => {
			assert.equal(await catchNotFound(Promise.resolve().then(render)), true);
		});
	});

	test("is not a registry action, so the API, MCP and docs don't list it", async () => {
		const { ACTIONS } = await import("../lib/actions/registry.js");
		assert.ok(!ACTIONS.some(({ name, http }) => /custom_(request|plan)|custom-(request|plan)/.test(`${name} ${http.path}`)));
	});
});
