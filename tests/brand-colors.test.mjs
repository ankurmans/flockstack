import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Night lime: FlockStack's own pages are ink and lime; a newsletter's own pages stay neutral.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(join(ROOT, path), "utf8");

// The tokens the brand sets, which a newsletter's pages set back.
const BRAND_TOKENS = [
	"primary",
	"primary-foreground",
	"ring",
	"link",
	"logo-lime",
	"selection",
	"chart-1",
	"chart-2",
	"chart-3",
	"chart-4",
	"chart-5",
	"sidebar-primary",
	"sidebar-primary-foreground",
	"sidebar-ring",
];

// The pages a newsletter's readers see: its archive (and shop, subscribe and issue pages under it) and what its emails link to.
const NEWSLETTER_PAGES = [
	"app/archive/[slug]/layout.js",
	"app/unsubscribe/page.js",
	"app/confirm/page.js",
	"app/keep/page.js",
	"app/referral/page.js",
	"app/reader/replies/page.js",
	"app/reader/signin/page.js",
];

function readBlock(css, selector) {
	const start = css.indexOf(`${selector} {`);
	assert.ok(start >= 0, `${selector} is in app/globals.css`);
	const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

describe("the logo", () => {
	test("is Stack F: a lime bar over two ink bars, each shorter than the one above", async () => {
		const { LOGO_SHAPES } = await import("../components/LogoFlockstack.jsx");
		assert.deepEqual(
			LOGO_SHAPES.map(({ tone }) => tone),
			["lime", "ink", "ink"]
		);
		const top = (d) => Number(/^M[\d.]+ ([\d.]+)/.exec(d)[1]);
		const right = (d) => Math.max(...[...d.matchAll(/H([\d.]+)/g)].map(([, x]) => Number(x)));
		const [first, second, third] = LOGO_SHAPES.map(({ d }) => d);
		assert.ok(top(first) < top(second) && top(second) < top(third), "the lime bar is the top one");
		assert.ok(right(first) > right(second) && right(second) > right(third), "each bar is shorter than the one above");
	});

	test("paints the lime bar with --logo-lime, so it follows the theme", async () => {
		const { default: LogoFlockstack } = await import("../components/LogoFlockstack.jsx");
		const html = renderToStaticMarkup(createElement(LogoFlockstack));
		assert.deepEqual(
			[...html.matchAll(/fill="([^"]+)"/g)].map(([, fill]) => fill),
			["var(--logo-lime)", "currentColor", "currentColor"]
		);
	});

	test("the browser icon and the web manifest use the app icon's ink tile", async () => {
		const { LOGO_SHAPES, LOGO_TILE } = await import("../components/LogoFlockstack.jsx");
		const icon = await read("app/icon.svg");
		assert.ok(icon.includes(`fill="${LOGO_TILE.background}"`));
		for (const { d, tone } of LOGO_SHAPES) assert.ok(icon.includes(`<path d="${d}" fill="${LOGO_TILE[tone]}"/>`), `${tone} chevron`);

		const manifest = await (await import("../app/site.webmanifest/route.js")).GET().json();
		assert.equal(manifest.theme_color, LOGO_TILE.background);
		assert.equal(manifest.background_color, LOGO_TILE.background);
	});
});

describe("a newsletter's own pages", () => {
	test("are inside theme-neutral", async () => {
		for (const page of NEWSLETTER_PAGES) assert.match(await read(page), /className="theme-neutral /, page);
	});

	test("set every brand token back to a neutral, in light and dark", async () => {
		const css = await read("app/globals.css");
		const brand = { light: readBlock(css, ":root"), dark: readBlock(css, ".dark") };
		const neutral = { light: readBlock(css, ":root:has(.theme-neutral)"), dark: readBlock(css, ".dark:has(.theme-neutral)") };
		for (const theme of ["light", "dark"]) {
			for (const token of BRAND_TOKENS) {
				assert.ok(brand[theme][token], `${theme} sets --${token}`);
				const value = neutral[theme][token];
				assert.ok(value, `the ${theme} neutral block sets --${token}`);
				const chroma = /^oklch\([\d.]+ ([\d.]+) /.exec(value)?.[1];
				assert.ok(chroma === undefined ? !/oklch/.test(value) : Number(chroma) === 0, `--${token} is neutral in ${theme}: ${value}`);
			}
		}
	});
});
