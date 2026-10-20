import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DARK_PAGE, FONT_PAIRS, FONT_PAIR_IDS, LIGHT_PAGE, THEME_IDS, getBrand, getContrast, getReadableAccent } from "../lib/brand.js";
import { getTextOn } from "../lib/editor-blocks.js";
import { renderEmail } from "../lib/render-email.js";
import { activate, callApi, as, form, signIn, startTestApp } from "./helpers/app.mjs";

// A newsletter's brand: an accent, a pair of fonts, a logo and a header, applied to the email and read from one place.
const ACCENTS = ["#ffd400", "#ffffff", "#000000", "#e11d48", "#1d4ed8", "#16a34a", "#f97316", "#7c3aed", "#9ca3af", "#fde68a", "#0f172a"];
const NEWSLETTER = {
	name: "Field notes",
	postalAddress: "1 Main St, Paris",
	imageUrl: "https://cdn.example.com/logo.png",
	accentColor: "#1d4ed8",
	brand: { theme: "magazine", fontPair: "editorial", headerUrl: "https://cdn.example.com/header.jpg", emailLogo: true },
};
const ISSUE = {
	format: "rich",
	html: '<h2>Heading</h2><p>Read <a href="https://example.com/post">the post</a>.</p><div data-button=""><a href="https://example.com/join">Join</a></div>',
	subject: "Issue",
	previewText: "Preview",
	webUrl: "https://field-notes.example.com/p/issue",
};
let app;

before(async () => {
	app = await startTestApp();
});

after(() => app?.stop());

describe("a brand's colors", () => {
	test("give links a shade readable at 4.5:1 on a white page and on a dark one, whatever the accent", () => {
		for (const accent of ACCENTS) {
			const brand = getBrand({ accentColor: accent });
			assert.ok(getContrast(brand.linkOnLight, LIGHT_PAGE) >= 4.5, `${accent} as a link on white: ${getContrast(brand.linkOnLight, LIGHT_PAGE).toFixed(2)}`);
			assert.ok(getContrast(brand.linkOnDark, DARK_PAGE) >= 4.5, `${accent} as a link on dark: ${getContrast(brand.linkOnDark, DARK_PAGE).toFixed(2)}`);
			assert.ok(getContrast(brand.accent, brand.accentOn) >= 4.5, `${accent} under its button text`);
			assert.ok(getContrast(brand.accentDark, brand.accentDarkOn) >= 4.5, `${accent} under its button text in the dark`);
			assert.ok(getContrast(brand.accentDark, DARK_PAGE) >= 3, `${accent} button against a dark page`);
		}
	});

	test("keep an accent that already reads, and shade one that doesn't toward the page's opposite", () => {
		assert.equal(getReadableAccent("#1d4ed8", LIGHT_PAGE), "#1d4ed8");
		const yellow = getReadableAccent("#ffd400", LIGHT_PAGE);
		assert.notEqual(yellow, "#ffd400");
		assert.ok(getContrast(yellow, LIGHT_PAGE) >= 4.5);
		assert.equal(getReadableAccent("#e11d48", DARK_PAGE) === "#e11d48" || getContrast(getReadableAccent("#e11d48", DARK_PAGE), DARK_PAGE) >= 4.5, true);
		assert.equal(getTextOn("#ffd400"), "#09090b");
	});

	test("default to near-black, the classic theme and the sans pair, and ignore what isn't a color, a theme or a pair", () => {
		const brand = getBrand({ name: "Plain", accentColor: "red", brand: { theme: "neon", fontPair: "comic" } });
		assert.deepEqual([brand.accent, brand.theme, brand.fontPair, brand.isCustom, brand.hasAccent], ["#18181b", "classic", "sans", false, false]);
		assert.equal(getBrand(null).theme, "classic");
	});

	test("offer four themes and four font pairs of fonts every device has", () => {
		assert.deepEqual(THEME_IDS, ["classic", "magazine", "minimal", "bold"]);
		assert.deepEqual(FONT_PAIR_IDS, ["sans", "serif", "editorial", "modern"]);
		for (const pair of Object.values(FONT_PAIRS)) {
			assert.match(pair.heading, /(Arial|serif)$/, "ends in a generic fallback");
			assert.match(pair.body, /(Arial|serif)$/);
			assert.doesNotMatch(pair.heading + pair.body, /Inter|Geist|Roboto Slab|Google/, "no web font");
		}
	});

	test("take a logo or header only as an https address, or a path when the email knows where paths are served", () => {
		const read = (imageUrl, headerUrl, assetBase) => getBrand({ imageUrl, brand: { headerUrl } }, { assetBase });
		assert.equal(read("https://cdn.example.com/a.png", "").logoUrl, "https://cdn.example.com/a.png");
		assert.equal(read("javascript:alert(1)", "http://example.com/a.png").logoUrl, "");
		assert.equal(read("javascript:alert(1)", "http://example.com/a.png").headerUrl, "");
		assert.equal(read("/logos/a.png", "").logoUrl, "", "a path without a base can't be linked from an email");
		assert.equal(read("/logos/a.png", "", "https://flockstack.io").logoUrl, "https://flockstack.io/logos/a.png");
	});
});

describe("an email in a newsletter's brand", () => {
	test("is unchanged for a newsletter that chose nothing: same link color, same font, no masthead", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: { name: "Plain", postalAddress: "1 Main St" } });
		assert.match(html, /\.body a \{ color: #18181b; \}/);
		assert.match(html, /max-width:600px;font-family:-apple-system,/);
		assert.doesNotMatch(html, /<img[^>]*logo|alt="Plain"/);
		assert.doesNotMatch(html, /<a style="color:/, "its links are styled by the stylesheet alone");
	});

	test("prints the accent on links and buttons, inline as well as in the stylesheet", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: NEWSLETTER });
		assert.match(html, /\.body a \{ color: #1d4ed8; \}/);
		assert.match(html, /<a style="color:#1d4ed8;" href="https:\/\/example\.com\/post">the post<\/a>/, "Outlook drops <style>, so the link carries its color");
		assert.match(html, /bgcolor="#1d4ed8"[^>]*background:#1d4ed8/, "the button is a table cell in the accent");
		assert.match(html, /color:#ffffff;text-decoration:none;">Join<\/a>/, "its label reads on the accent");
	});

	test("shades a pale accent for links and keeps it for the button", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: { ...NEWSLETTER, accentColor: "#ffd400" } });
		const link = getBrand({ accentColor: "#ffd400" }).linkOnLight;
		assert.match(html, new RegExp(`\\.body a \\{ color: ${link}; \\}`));
		assert.ok(getContrast(link, "#ffffff") >= 4.5);
		assert.match(html, /bgcolor="#ffd400"/);
		assert.match(html, /color:#09090b;text-decoration:none;">Join<\/a>/, "dark text on a yellow button");
	});

	test("sets the pair's fonts on the text and on the headings, and only fonts every device has", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: NEWSLETTER });
		assert.ok(html.includes(`max-width:600px;font-family:${FONT_PAIRS.editorial.body};`), "body text");
		assert.ok(html.includes(`<h2 style="font-family:${FONT_PAIRS.editorial.heading};color:#09090b;">Heading</h2>`), "a heading carries its font inline");
		assert.match(html, /\.body h1, \.body h2, \.body h3 \{ font-family: Georgia,/);
		for (const id of FONT_PAIR_IDS) {
			const out = renderEmail({ ...ISSUE, newsletter: { ...NEWSLETTER, brand: { fontPair: id } } }).html;
			assert.ok(out.includes(FONT_PAIRS[id].body), id);
		}
	});

	test("opens with the logo and name, then the header image, in tables, with the name as text", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: NEWSLETTER });
		const top = html.slice(html.indexOf("Read online"), html.indexOf('<td class="body">'));
		assert.match(top, /<img src="https:\/\/cdn\.example\.com\/logo\.png" width="40" height="40" alt=""/);
		assert.match(top, />Field notes<\/a><\/td>/, "the name is text, so a darkened logo never hides it");
		assert.match(top, /<img src="https:\/\/cdn\.example\.com\/header\.jpg" width="560" alt="Field notes"/);
		assert.ok(top.indexOf("logo.png") < top.indexOf("header.jpg"), "the logo first");
		assert.doesNotMatch(top, /<div|display:flex|display:grid|<svg/, "no layout Outlook can't read");
		assert.match(top, /href="https:\/\/field-notes\.example\.com\/p\/issue"/, "both lead to the issue's page");
	});

	test("leaves the logo out until the writer asks for it, and the header out without a link", () => {
		const noLogo = renderEmail({ ...ISSUE, newsletter: { ...NEWSLETTER, brand: { ...NEWSLETTER.brand, emailLogo: false } } }).html;
		assert.doesNotMatch(noLogo, /logo\.png/);
		assert.match(noLogo, /header\.jpg/);
		const noHeader = renderEmail({ ...ISSUE, newsletter: { ...NEWSLETTER, brand: { ...NEWSLETTER.brand, headerUrl: "" } } }).html;
		assert.doesNotMatch(noHeader, /header\.jpg/);
	});

	test("escapes the name, drops an address that isn't https, and links a path only when sent with a base", () => {
		const hostile = { ...NEWSLETTER, name: '<script>alert("x")</script>', imageUrl: "javascript:alert(1)", brand: { emailLogo: true, headerUrl: 'http://example.com/a.png"onerror="x' } };
		const { html } = renderEmail({ ...ISSUE, newsletter: hostile });
		assert.doesNotMatch(html, /<script>alert|javascript:|onerror/);
		assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
		const path = { ...NEWSLETTER, imageUrl: "/logos/a.png" };
		assert.doesNotMatch(renderEmail({ ...ISSUE, newsletter: path }).html, /logos\/a\.png/);
		assert.match(renderEmail({ ...ISSUE, newsletter: path, assetBase: "https://flockstack.io" }).html, /src="https:\/\/flockstack\.io\/logos\/a\.png"/);
	});

	test("stays light and says so, and the web version carries no masthead", () => {
		const { html } = renderEmail({ ...ISSUE, newsletter: NEWSLETTER });
		assert.match(html, /<meta name="color-scheme" content="light">/);
		assert.match(html, /<meta name="supported-color-schemes" content="light">/);
		assert.match(html, /:root \{ color-scheme: light; \}/);
		const web = renderEmail({ ...ISSUE, newsletter: NEWSLETTER, isWebVersion: true }).html;
		assert.doesNotMatch(web, /logo\.png|header\.jpg/);
	});

	test("brands a Markdown email too, and leaves a designed HTML email alone", () => {
		const markdown = renderEmail({ format: "markdown", markdown: "# Title\n\nSee [this](https://example.com).", subject: "S", newsletter: NEWSLETTER }).html;
		assert.match(markdown, /<a style="color:#1d4ed8;" href="https:\/\/example\.com">this<\/a>/);
		const designed = renderEmail({ format: "html", html: "<html><body><h1>Mine</h1></body></html>", subject: "S", newsletter: NEWSLETTER }).html;
		assert.doesNotMatch(designed, /logo\.png|header\.jpg|1d4ed8/);
	});

	test("puts the upgrade card and button in the accent for free readers", () => {
		const html = renderEmail({
			...ISSUE,
			html: "<p>Free part</p><div data-paywall=\"\"></div><p>Paid part</p>",
			newsletter: NEWSLETTER,
			readerTier: "free",
			upgradeUrl: "https://field-notes.example.com/subscribe",
		}).html;
		assert.match(html, /bgcolor="#1d4ed8"/);
		assert.doesNotMatch(html, /Paid part/);
	});
});

describe("saving a brand", () => {
	let counter = 0;
	async function customer() {
		const user = await signIn(`brand${++counter}@example.com`);
		await activate(user);
		const { createApiKey } = await import("../app/(app)/api-keys/actions.js");
		user.key = (await as(user, () => createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		return user;
	}
	const patch = (user, slug, body) => callApi("PATCH", `/api/v1/newsletters/${slug}`, { key: user.key, body });

	test("through the API: theme, fonts, header and email logo, merged with what was saved", async () => {
		const user = await customer();
		const created = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "Brand notes" } });
		assert.equal(created.status, 201);
		assert.deepEqual(created.body.brand, { theme: "classic", fontPair: "sans", headerUrl: "", emailLogo: false }, "a new newsletter starts plain");

		const saved = await patch(user, created.body.slug, { accentColor: "#1d4ed8", brand: { theme: "bold", fontPair: "serif" } });
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		assert.deepEqual(saved.body.brand, { theme: "bold", fontPair: "serif", headerUrl: "", emailLogo: false });
		const more = await patch(user, created.body.slug, { brand: { headerUrl: "https://cdn.example.com/h.jpg", emailLogo: true } });
		assert.deepEqual(more.body.brand, { theme: "bold", fontPair: "serif", headerUrl: "https://cdn.example.com/h.jpg", emailLogo: true }, "a change keeps the fields it leaves out");
		const cleared = await patch(user, created.body.slug, { brand: { headerUrl: "" } });
		assert.equal(cleared.body.brand.headerUrl, "");
		assert.equal((await callApi("GET", `/api/v1/newsletters/${created.body.slug}`, { key: user.key })).body.brand.theme, "bold");
	});

	test("refuses a theme or a font pair that doesn't exist, and a header that isn't an https address", async () => {
		const user = await customer();
		const { body } = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "Brand checks" } });
		for (const bad of [{ theme: "neon" }, { fontPair: "comic" }]) {
			const response = await patch(user, body.slug, { brand: bad });
			assert.equal(response.status, 400, JSON.stringify(bad));
		}
		const header = await patch(user, body.slug, { brand: { headerUrl: "http://example.com/h.jpg" } });
		assert.equal(header.status, 400, JSON.stringify(header.body));
		assert.match(JSON.stringify(header.body), /https/);
		const script = await patch(user, body.slug, { brand: { headerUrl: "javascript:alert(1)" } });
		assert.equal(script.status, 400);
	});
});
