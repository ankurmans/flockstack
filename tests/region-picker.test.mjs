import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { as, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// "Where should your data live?" on the sign-in page: what it starts on, where choosing leads, and
// how the account and admin pages say which region they are in. This process is the US Worker; withEnv makes it the EU one.
const US_SIGNIN = "https://flockstack.io/signin";
const EU_SIGNIN = "https://eu.flockstack.io/signin";
const EU = { FLOCKSTACK_REGION: "eu", APP_URL: "https://eu.flockstack.io" };
const HINT = /Already have an account in the other region\?\s*<a [^>]*>Sign in there\.<\/a>/;

let app;
let m;

function hrefsOf(markup) {
	return [...markup.matchAll(/<a [^>]*?href="([^"]*)"/g)].map(([, href]) => href.replaceAll("&amp;", "&"));
}

// The picker's links in order (US, EU) and which one is current.
function readPicker(markup) {
	const group = /<div role="group" aria-label="Where should your data live\?"[\s\S]*?<\/ul>/.exec(markup)?.[0];
	if (!group) return null;
	const links = [...group.matchAll(/<a href="([^"]*)"( aria-current="true")?/g)].map(([, href, current]) => ({ href: href.replaceAll("&amp;", "&"), current: Boolean(current) }));
	return { us: links[0], eu: links[1], selected: links.filter(({ current }) => current).length === 1 ? (links[0].current ? "us" : "eu") : null };
}

function visit(page, searchParams = {}, { country, jar = new Map(), headers = {} } = {}) {
	return runWithRequest({ jar, headers: { ...(country && { "cf-ipcountry": country }), ...headers } }, async () =>
		renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(searchParams) }))
	);
}

before(async () => {
	app = await startTestApp();
	m = {
		signin: await import("../app/signin/page.js"),
		account: await import("../app/(account)/account/page.js"),
		adminLayout: await import("../app/admin/layout.js"),
	};
});

after(() => app?.stop());

describe("sign-in page", () => {
	test("a visitor from the US starts on the United States, with the form and a hint to sign in to the other region", async () => {
		const markup = await visit(m.signin, {}, { country: "US" });
		const picker = readPicker(markup);
		assert.equal(picker.selected, "us");
		assert.equal(picker.us.href, "/signin?region=us");
		assert.equal(picker.eu.href, `${EU_SIGNIN}?region=eu`);
		assert.match(markup, /Where should your data live\?/);
		assert.match(markup, /name="email"/);
		assert.match(markup, HINT);
		assert.ok(hrefsOf(markup).includes(`${EU_SIGNIN}?region=eu`));
	});

	test("a visitor from the EU, the UK or Switzerland starts on the European Union and is sent there to sign in, next kept", async () => {
		for (const country of ["DE", "FR", "NO", "GB", "CH"]) {
			const markup = await visit(m.signin, { next: "/campaigns/abc" }, { country });
			const picker = readPicker(markup);
			assert.equal(picker.selected, "eu", country);
			assert.doesNotMatch(markup, /name="email"/, "the form belongs to the region the account will be in");
			assert.match(markup, /will be stored in the European Union/);
			const continueHref = `${EU_SIGNIN}?region=eu&next=%2Fcampaigns%2Fabc`;
			assert.ok(hrefsOf(markup).includes(continueHref), country);
			assert.match(markup, /Continue in the European Union/);
			assert.match(markup, HINT);
			assert.equal(picker.us.href, "/signin?region=us&next=%2Fcampaigns%2Fabc");
		}
	});

	test("?region= wins over the country, and the region cookie wins over it too, but not over ?region=", async () => {
		assert.equal(readPicker(await visit(m.signin, { region: "us" }, { country: "DE" })).selected, "us");
		assert.equal(readPicker(await visit(m.signin, { region: "eu" }, { country: "US" })).selected, "eu");
		assert.equal(readPicker(await visit(m.signin, {}, { country: "DE", jar: new Map([["region", "us"]]) })).selected, "us");
		assert.equal(readPicker(await visit(m.signin, {}, { country: "US", jar: new Map([["region", "eu"]]) })).selected, "eu");
		assert.equal(readPicker(await visit(m.signin, { region: "us" }, { country: "US", jar: new Map([["region", "eu"]]) })).selected, "us");
		assert.equal(readPicker(await visit(m.signin, { region: "nowhere" }, { country: "DE" })).selected, "eu", "an unknown region is ignored");
		assert.equal(readPicker(await visit(m.signin, {}, { country: "DE", jar: new Map([["region", "<b>"]]) })).selected, "eu");
	});

	test("without a country it starts on the Worker's own region", async () => {
		assert.equal(readPicker(await visit(m.signin)).selected, "us");
		await withEnv(EU, async () => assert.equal(readPicker(await visit(m.signin)).selected, "eu"));
	});

	test("the country comes from Cloudflare's request data when the header is missing", async () => {
		const stub = await import("./stubs/opennext-cloudflare.mjs");
		stub.setCf({ country: "IE" });
		try {
			assert.equal(readPicker(await visit(m.signin)).selected, "eu");
			assert.equal(readPicker(await visit(m.signin, {}, { country: "US" })).selected, "us", "the header comes first");
		} finally {
			stub.setCf(undefined);
		}
	});

	test("on the EU Worker the picker starts on the European Union whatever the country, and links to the US sign-in", async () => {
		await withEnv(EU, async () => {
			const markup = await visit(m.signin, { next: "/billing" }, { country: "US" });
			const picker = readPicker(markup);
			assert.equal(picker.selected, "eu");
			assert.equal(picker.eu.href, "/signin?region=eu&next=%2Fbilling");
			assert.equal(picker.us.href, `${US_SIGNIN}?region=us&next=%2Fbilling`);
			assert.match(markup, /name="email"/);
			assert.match(markup, HINT);
			assert.ok(hrefsOf(markup).filter((href) => href.startsWith(US_SIGNIN)).length >= 2, "the picker and the hint");
		});
	});

	test("on the EU Worker, choosing the United States leads to the US sign-in and hides the form", async () => {
		await withEnv(EU, async () => {
			const markup = await visit(m.signin, { region: "us", next: "/billing" });
			assert.equal(readPicker(markup).selected, "us");
			assert.doesNotMatch(markup, /name="email"/);
			assert.match(markup, /Continue in the United States/);
			assert.ok(hrefsOf(markup).includes(`${US_SIGNIN}?region=us&next=%2Fbilling`));
		});
	});

	test("the other region's addresses come from REGION_URL_US and REGION_URL_EU", async () => {
		await withEnv({ REGION_URL_EU: "https://eu.example.com/" }, async () => {
			const markup = await visit(m.signin, {}, { country: "DE" });
			assert.ok(hrefsOf(markup).includes("https://eu.example.com/signin?region=eu"));
			assert.match(markup, /eu\.example\.com<\/span>/);
		});
	});

	test("a self-hosted server has one region: no picker, no hint", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => {
			const markup = await visit(m.signin, {}, { country: "DE" });
			assert.equal(readPicker(markup), null);
			assert.doesNotMatch(markup, /other region/);
			assert.match(markup, /name="email"/);
		});
	});
});

describe("account and admin pages", () => {
	test("the account page says where the data is stored", async () => {
		const user = await signIn("region-account@example.com");
		const markup = await as(user, async () => renderToStaticMarkup(await m.account.default()));
		assert.match(markup, /Your data is stored in the United States\./);
		await withEnv(EU, async () => {
			const eu = await as(user, async () => renderToStaticMarkup(await m.account.default()));
			assert.match(eu, /Your data is stored in the European Union\./);
		});
		await withEnv({ FLOCKSTACK_CLOUD: "", ALLOWED_EMAILS: user.email }, async () => {
			const selfHosted = await as(user, async () => renderToStaticMarkup(await m.account.default()));
			assert.doesNotMatch(selfHosted, /Your data is stored in/);
		});
	});

	test("the admin header names the region", async () => {
		const admin = await signIn("admin@example.com");
		const render = () => as(admin, async () => renderToStaticMarkup(createElement(TooltipProvider, null, await m.adminLayout.default({ children: null }))));
		assert.match(await render(), />United States<\/span>/);
		await withEnv(EU, async () => assert.match(await render(), />European Union<\/span>/));
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => assert.doesNotMatch(await render(), /United States|European Union/));
	});
});
