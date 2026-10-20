import { DEFAULT_FONT_PAIR, FONT_PAIRS, MIN_SHAPE_CONTRAST, THEME_IDS, getBrand, getContrast, getLuminance, getReadableAccent } from "./brand.js";
import { getTextOn } from "./editor-blocks.js";

// The website's four themes. classic keeps the neutral design every archive had; the others set the page's colors here,
// as hex, so the contrast of each pair is tested (tests/site-themes.test.mjs) and one source feeds both the website
// and the settings page's preview. Their layout lives in app/globals.css, under [data-site-theme].
export const THEMES = {
	// Its colors are the app's neutral ones (app/globals.css), so only the surfaces text sits on are listed, as hex, for the
	// accent's contrast.
	classic: {
		label: "Classic",
		description: "Neutral and airy, with cards for every issue",
		surfaces: { light: ["#ffffff", "#f5f5f5"], dark: ["#0a0a0a", "#171717", "#262626"] },
	},
	magazine: {
		label: "Magazine",
		description: "Warm paper, a masthead and sharp corners",
		light: { background: "#faf6ee", foreground: "#1c1917", card: "#fffdf8", muted: "#f1ebdd", mutedForeground: "#57534e", border: "#e0d6c2" },
		dark: { background: "#1a1714", foreground: "#f5efe6", card: "#231f1b", muted: "#2e2822", mutedForeground: "#b8ad9d", border: "#3a342d" },
	},
	minimal: {
		label: "Minimal",
		description: "Text first: a plain list of issues, no pictures",
		light: { background: "#ffffff", foreground: "#111111", card: "#ffffff", muted: "#f4f4f5", mutedForeground: "#52525b", border: "#e4e4e7" },
		dark: { background: "#0b0b0c", foreground: "#f4f4f5", card: "#0b0b0c", muted: "#1b1b1d", mutedForeground: "#a1a1aa", border: "#27272a" },
	},
	bold: {
		label: "Bold",
		description: "A header in your accent color and heavy headlines",
		light: { background: "#ffffff", foreground: "#09090b", card: "#f5f5f4", muted: "#ececea", mutedForeground: "#4b4b4b", border: "#d4d4d0" },
		dark: { background: "#09090b", foreground: "#fafafa", card: "#18181b", muted: "#27272a", mutedForeground: "#b4b4bb", border: "#3f3f46" },
	},
};

// The pages a theme paints in one scheme, which text, links and buttons have to read on.
export function getSurfaces(themeId, scheme) {
	const theme = THEMES[themeId];
	if (theme.surfaces) return theme.surfaces[scheme];
	const { background, card, muted } = theme[scheme];
	return [background, card, muted];
}

// The accent as it reads on one theme in one scheme: links the shade that holds 4.5:1 on its dullest surface (the darkest
// in light, the lightest in dark), and a button in the accent itself, or on a dark page that would sink into it (under
// 3:1), the lighter shade the links use. Each with its text, black or white.
export function getThemeAccent(accent, themeId, scheme) {
	const surfaces = getSurfaces(themeId, scheme);
	const isDark = scheme === "dark";
	const worst = [...surfaces].sort((a, b) => (isDark ? getLuminance(b) - getLuminance(a) : getLuminance(a) - getLuminance(b)))[0];
	const link = getReadableAccent(accent, worst);
	const base = surfaces[0];
	const fill = isDark && getContrast(accent, base) < MIN_SHAPE_CONTRAST ? link : accent;
	return { link, fill, on: getTextOn(fill) };
}

const TOKEN_NAMES = {
	background: ["--background"],
	foreground: ["--foreground", "--card-foreground", "--popover-foreground", "--secondary-foreground", "--accent-foreground"],
	card: ["--card", "--popover"],
	muted: ["--muted", "--secondary", "--accent"],
	mutedForeground: ["--muted-foreground"],
	border: ["--border", "--input"],
};

function declarations(palette) {
	return Object.entries(palette)
		.flatMap(([name, value]) => TOKEN_NAMES[name].map((token) => `${token}:${value}`))
		.join(";");
}

// The accent's tokens: buttons, the focus ring and links. Only #rrggbb values go in (lib/brand.js checks them), so
// nothing a writer typed reaches the stylesheet as anything else.
function accentDeclarations(brand, themeId, isDark) {
	if (!brand.hasAccent) return "";
	const { link, fill, on } = getThemeAccent(brand.accent, themeId, isDark ? "dark" : "light");
	return `--primary:${fill};--primary-foreground:${on};--ring:${fill};--link:${link};--site-link:${link};--site-accent:${fill};--site-accent-on:${on}`;
}

function fontDeclarations(brand) {
	if (brand.fontPair === DEFAULT_FONT_PAIR) return "";
	const { heading, body } = FONT_PAIRS[brand.fontPair];
	return `--site-font-body:${body};--site-font-heading:${heading}`;
}

// The stylesheet for one newsletter's website: its theme's palette, its accent and its fonts, on the page's root (so
// dialogs and toasts outside the page follow) and on the element that carries data-site-theme (so the settings page's
// preview does too).
export function getSiteCss(newsletter, { only } = {}) {
	const brand = getBrand(newsletter);
	return getThemeCss(brand, only);
}

export function getThemeCss(brand, only) {
	const rules = [];
	for (const id of only ? [only] : THEME_IDS) {
		const theme = THEMES[id];
		const scope = `[data-site-theme="${id}"]`;
		const light = [theme.light && declarations(theme.light), accentDeclarations(brand, id, false), fontDeclarations(brand)].filter(Boolean).join(";");
		const dark = [theme.dark && declarations(theme.dark), accentDeclarations(brand, id, true)].filter(Boolean).join(";");
		rules.push(`:root:has(${scope}),${scope}{${light}}`);
		rules.push(`.dark:has(${scope}),.dark ${scope}{${dark}}`);
	}
	return rules.join("\n");
}
