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
		// The tab icon is the ink square by default and a light square on a dark browser theme.
		const icon = await read("app/icon.svg");
		const [base, dark] = icon.split("@media (prefers-color-scheme:dark)");
		assert.ok(base.includes(`.bg{fill:${LOGO_TILE.background}}`) && base.includes(`.ink{fill:${LOGO_TILE.ink}}`) && base.includes(`.lime{fill:${LOGO_TILE.lime}}`));
		assert.ok(dark.includes(`.bg{fill:#f2f2f2}`) && dark.includes(`.ink{fill:#0b0b0b}`));
		for (const { d, tone } of LOGO_SHAPES) assert.ok(icon.includes(`<path class="${tone}" d="${d}"/>`), `${tone} bar`);
		assert.ok(!/<rect[^>]*rx=/.test(icon), "a square, not a rounded tile");

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

// WCAG 2's contrast of two colors in app/globals.css's oklch(L C h), through OKLab to sRGB (outside sRGB, each channel is
// clipped, near enough to a browser's mapping for these tones). A tint like bg-destructive/10 is mixed over what's behind
// it in sRGB, as browsers paint it.
function toLinearRgb(value) {
	const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
	assert.ok(match, `${value} is an oklch() color`);
	const [lightness, chroma, hue] = match.slice(1).map(Number);
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map((channel) => Math.min(1, Math.max(0, channel)));
}

const encode = (channel) => (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);
const decode = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const tint = (color, behind, alpha) => color.map((channel, i) => decode(encode(channel) * alpha + encode(behind[i]) * (1 - alpha)));
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(first, second) {
	const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

describe("small text", () => {
	// Each theme's tokens as a page sees them: a newsletter's neutral blocks set some, the rest come from the brand's.
	async function themes() {
		const css = await read("app/globals.css");
		const light = readBlock(css, ":root");
		const dark = { ...light, ...readBlock(css, ".dark") };
		return {
			light,
			dark,
			"neutral light": { ...light, ...readBlock(css, ":root:has(.theme-neutral)") },
			"neutral dark": { ...dark, ...readBlock(css, ".dark:has(.theme-neutral)") },
		};
	}

	test("grey text holds 4.5:1 on grey chips, cards and the page, in every theme", async () => {
		for (const [name, tokens] of Object.entries(await themes())) {
			const text = toLinearRgb(tokens["muted-foreground"]);
			for (const surface of ["muted", "background", "card", "sidebar", "popover"]) {
				const ratio = contrast(text, toLinearRgb(tokens[surface]));
				assert.ok(ratio >= 4.5, `${name}: muted-foreground on ${surface} is ${ratio.toFixed(2)}:1`);
			}
			// bg-muted/60 on a card: the read-only fields on the account page.
			const ratio = contrast(text, tint(toLinearRgb(tokens.muted), toLinearRgb(tokens.card), 0.6));
			assert.ok(ratio >= 4.5, `${name}: muted-foreground on muted/60 is ${ratio.toFixed(2)}:1`);
		}
	});

	test("red text holds 4.5:1 on its own tint (the destructive badge: reports, Removed) and on the page", async () => {
		for (const [name, tokens] of Object.entries(await themes())) {
			const red = toLinearRgb(tokens.destructive);
			// The badge's destructive variant: bg-destructive/10, and /20 in dark mode.
			const alpha = name.includes("dark") ? 0.2 : 0.1;
			for (const surface of ["background", "card"]) {
				const behind = toLinearRgb(tokens[surface]);
				const onTint = contrast(red, tint(red, behind, alpha));
				assert.ok(onTint >= 4.5, `${name}: destructive on its tint over ${surface} is ${onTint.toFixed(2)}:1`);
				const plain = contrast(red, behind);
				assert.ok(plain >= 4.5, `${name}: destructive on ${surface} is ${plain.toFixed(2)}:1`);
			}
			const onMuted = contrast(red, toLinearRgb(tokens.muted));
			assert.ok(onMuted >= 4.5, `${name}: destructive on muted is ${onMuted.toFixed(2)}:1`);
		}
	});

	test("the two light pairs the audit measured clear 4.5:1 with room", async () => {
		const { light } = await themes();
		const grey = contrast(toLinearRgb(light["muted-foreground"]), toLinearRgb(light.muted));
		const red = toLinearRgb(light.destructive);
		const badge = contrast(red, tint(red, toLinearRgb(light.background), 0.1));
		assert.ok(grey >= 4.8, `grey on a grey chip: ${grey.toFixed(2)}:1, was 4.35:1`);
		assert.ok(badge >= 4.6, `red on the red badge: ${badge.toFixed(2)}:1, was 3.97:1`);
	});
});
