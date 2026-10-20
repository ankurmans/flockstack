import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FONT_PAIRS, MIN_SHAPE_CONTRAST, MIN_TEXT_CONTRAST, THEME_IDS, getBrand, getContrast } from "../lib/brand.js";
import { THEMES, getSiteCss, getSurfaces, getThemeAccent, getThemeCss } from "../lib/site-themes.js";

// The website's themes keep their text at 4.5:1 on every surface they paint, in light and dark, with any accent a writer
// picks; the CSS they become carries nothing but constants and checked colors.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCENTS = ["#ffd400", "#ffffff", "#000000", "#e11d48", "#1d4ed8", "#16a34a", "#f97316", "#7c3aed", "#9ca3af", "#fde68a", "#0f172a", "#1e3a8a", "#facc15", "#14532d"];
const SCHEMES = ["light", "dark"];
const PALETTE_THEMES = THEME_IDS.filter((id) => THEMES[id].light);

describe("each theme's palette", () => {
	test("holds 4.5:1 for its text on its page, its cards and its grey chips, in light and in dark", () => {
		for (const id of PALETTE_THEMES) {
			for (const scheme of SCHEMES) {
				const { background, foreground, card, muted, mutedForeground } = THEMES[id][scheme];
				for (const [name, surface] of Object.entries({ background, card, muted })) {
					const text = getContrast(foreground, surface);
					assert.ok(text >= MIN_TEXT_CONTRAST, `${id} ${scheme}: text on ${name} is ${text.toFixed(2)}:1`);
					const grey = getContrast(mutedForeground, surface);
					assert.ok(grey >= MIN_TEXT_CONTRAST, `${id} ${scheme}: grey text on ${name} is ${grey.toFixed(2)}:1`);
				}
			}
		}
	});

	test("tells the page, a card and a chip apart from each other's edges, and sets every token the neutral theme sets", () => {
		const tokens = Object.keys(THEMES.magazine.light);
		for (const id of PALETTE_THEMES) {
			for (const scheme of SCHEMES) {
				assert.deepEqual(Object.keys(THEMES[id][scheme]), tokens, `${id} ${scheme}`);
				for (const value of Object.values(THEMES[id][scheme])) assert.match(value, /^#[0-9a-f]{6}$/);
				const { background, border } = THEMES[id][scheme];
				assert.notEqual(background, border);
			}
		}
	});

	test("stays dark in dark mode and light in light mode", () => {
		for (const id of PALETTE_THEMES) {
			assert.ok(getContrast(THEMES[id].light.background, "#ffffff") < 1.2, `${id} light page`);
			assert.ok(getContrast(THEMES[id].dark.background, "#000000") < 1.6, `${id} dark page`);
		}
	});

	test("offers four themes with a name and a line each", () => {
		assert.deepEqual(Object.keys(THEMES), THEME_IDS);
		for (const theme of Object.values(THEMES)) assert.ok(theme.label && theme.description.length > 10);
	});
});

describe("an accent on each theme", () => {
	test("makes links that hold 4.5:1 on every surface of the theme, in both schemes, whatever the accent", () => {
		for (const accent of ACCENTS) {
			for (const id of THEME_IDS) {
				for (const scheme of SCHEMES) {
					const { link } = getThemeAccent(accent, id, scheme);
					for (const surface of getSurfaces(id, scheme)) {
						const ratio = getContrast(link, surface);
						assert.ok(ratio >= MIN_TEXT_CONTRAST, `${accent} link on ${id} ${scheme} ${surface}: ${ratio.toFixed(2)}:1`);
					}
				}
			}
		}
	});

	test("makes buttons whose text holds 4.5:1, and that don't sink into a dark page", () => {
		for (const accent of ACCENTS) {
			for (const id of THEME_IDS) {
				for (const scheme of SCHEMES) {
					const { fill, on } = getThemeAccent(accent, id, scheme);
					assert.ok(getContrast(fill, on) >= MIN_TEXT_CONTRAST, `${accent} ${id} ${scheme}: label on button`);
					if (scheme === "dark") assert.ok(getContrast(fill, getSurfaces(id, scheme)[0]) >= MIN_SHAPE_CONTRAST, `${accent} ${id} dark: button against the page`);
				}
			}
		}
	});

	test("keeps a color that already reads, so a brand color shows as chosen", () => {
		assert.equal(getThemeAccent("#1d4ed8", "classic", "light").link, "#1d4ed8");
		assert.equal(getThemeAccent("#1d4ed8", "magazine", "light").fill, "#1d4ed8");
	});

	test("the bold hero's text reads on the accent in both schemes, since it is painted in it", () => {
		for (const accent of ACCENTS) {
			for (const scheme of SCHEMES) {
				const { fill, on } = getThemeAccent(accent, "bold", scheme);
				assert.ok(getContrast(fill, on) >= MIN_TEXT_CONTRAST, `${accent} ${scheme}`);
			}
		}
	});
});

describe("the stylesheet", () => {
	test("has a light and a dark rule for the root and for the element, and only the theme asked for", () => {
		const css = getThemeCss(getBrand({ accentColor: "#1d4ed8", brand: { fontPair: "serif" } }), "bold");
		const rules = css.split("\n");
		assert.equal(rules.length, 2);
		assert.match(rules[0], /^:root:has\(\[data-site-theme="bold"\]\),\[data-site-theme="bold"\]\{/);
		assert.match(rules[1], /^\.dark:has\(\[data-site-theme="bold"\]\),\.dark \[data-site-theme="bold"\]\{/);
		assert.match(rules[0], /--site-font-body:Georgia/);
		assert.equal(getThemeCss(getBrand({}), undefined).split("\n").length, THEME_IDS.length * 2);
	});

	test("carries only constants and #rrggbb colors, whatever the newsletter holds", () => {
		const hostile = { accentColor: "red;}</style><script>alert(1)</script>", brand: { theme: "x{}", fontPair: "';}", headerUrl: "javascript:alert(1)" }, name: "</style>" };
		const css = getSiteCss(hostile);
		assert.doesNotMatch(css, /script|alert|javascript|<|red;/);
		assert.equal(css.includes("--primary"), false, "an accent that isn't a color is no accent");
		const valid = getSiteCss({ accentColor: "#1D4ED8", brand: { theme: "minimal" } });
		for (const [, value] of valid.matchAll(/--(?:primary|ring|link|site-link|site-accent):([^;}]+)/g)) assert.match(value, /^#[0-9a-f]{6}$/);
		assert.match(valid, /--primary:#1d4ed8/, "lowercased");
	});

	test("sets the fonts only for a pair that isn't the default, from the pairs' own stacks", () => {
		assert.doesNotMatch(getSiteCss({ brand: { fontPair: "sans" } }), /--site-font/);
		for (const id of ["serif", "editorial", "modern"]) {
			const css = getSiteCss({ brand: { fontPair: id } });
			assert.ok(css.includes(`--site-font-body:${FONT_PAIRS[id].body}`), id);
			assert.ok(css.includes(`--site-font-heading:${FONT_PAIRS[id].heading}`), id);
		}
	});

	test("is backed by layout rules in globals.css for every theme but the classic one", async () => {
		const css = await readFile(join(ROOT, "app/globals.css"), "utf8");
		for (const id of PALETTE_THEMES) assert.ok(css.includes(`[data-site-theme="${id}"]`), `${id} has layout rules`);
		assert.match(css, /\[data-site-theme\] \.prose-issue a \{/, "issue links wear the accent");
	});

	test("is set inside the neutral theme, which every page of a newsletter's site keeps", async () => {
		const layout = await readFile(join(ROOT, "app/archive/[slug]/layout.js"), "utf8");
		assert.match(layout, /data-site-theme=\{theme\} className="theme-neutral /);
		for (const page of ["app/archive/[slug]/signin/page.js", "app/archive/[slug]/account/page.js", "app/archive/[slug]/issues/page.js"]) {
			const source = await readFile(join(ROOT, page), "utf8");
			assert.doesNotMatch(source, /<html|<body/, `${page} lives inside the layout`);
		}
	});
});
