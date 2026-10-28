import { ACCENT_PATTERN, DEFAULT_ACCENT, getAccent, getTextOn } from "./editor-blocks.js";

// A newsletter's brand: one accent color, a pair of fonts, a logo and a header image, applied to the email
// (lib/render-email.js) and the website (lib/site-themes.js) from the same values. Free of server modules: the
// settings page renders both for its preview.

// Fonts that exist on every reader's device, so the email and the website show the same letters. "sans" is the
// default: the website keeps its own typeface, the email the system's.
const SYSTEM_SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const GEORGIA = "Georgia,'Times New Roman',Times,serif";
const HELVETICA = "'Helvetica Neue',Helvetica,Arial,sans-serif";

export const FONT_PAIRS = {
	sans: { label: "Sans", description: "Clean sans-serif throughout", heading: SYSTEM_SANS, body: SYSTEM_SANS },
	serif: { label: "Serif", description: "Georgia throughout, like a book", heading: GEORGIA, body: GEORGIA },
	editorial: { label: "Editorial", description: "Georgia headlines over a sans-serif text", heading: GEORGIA, body: SYSTEM_SANS },
	modern: { label: "Modern", description: "Helvetica headlines over Georgia text", heading: HELVETICA, body: GEORGIA },
	helvetica: { label: "Helvetica", description: "Helvetica throughout", heading: HELVETICA, body: HELVETICA },
	// Web fonts served from FlockStack itself (no request to Google), on the website only: email clients ignore web fonts, so
	// the email shows the device's sans-serif, which it falls back to here.
	grotesk: { label: "Grotesk", description: "Host Grotesk headlines over Inter text on the website; the device's sans-serif in email", heading: `'Host Grotesk',${SYSTEM_SANS}`, body: `Inter,${SYSTEM_SANS}`, webFonts: ["Host Grotesk", "Inter"] },
};
export const FONT_PAIR_IDS = Object.keys(FONT_PAIRS);
export const DEFAULT_FONT_PAIR = "sans";

export const THEME_IDS = ["classic", "magazine", "minimal", "bold"];
export const DEFAULT_THEME = "classic";

const BLACK = "#000000";
const WHITE = "#ffffff";
// The darkest page a theme paints, and the lightest, which an accent used as text has to read on.
export const LIGHT_PAGE = "#ffffff";
export const DARK_PAGE = "#0a0a0a";
export const MIN_TEXT_CONTRAST = 4.5;
// A button needs less: its label carries it, but its edge should still show against the page.
export const MIN_SHAPE_CONTRAST = 3;
const IMAGE_URL_PATTERN = /^https:\/\/[^\s"'<>]{4,490}$/;

function toChannels(hex) {
	return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function toHex(channels) {
	return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function getLuminance(hex) {
	const [r, g, b] = toChannels(hex)
		.map((channel) => channel / 255)
		.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2's contrast of two #rrggbb colors, 1 to 21.
export function getContrast(first, second) {
	const [light, dark] = [getLuminance(first), getLuminance(second)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

function mixToward(hex, target, share) {
	const from = toChannels(hex);
	const to = toChannels(target);
	return toHex(from.map((channel, index) => channel + (to[index] - channel) * share));
}

// The accent itself when it reads as text on the background, else the nearest shade that does: darker on a light page,
// lighter on a dark one. A pale yellow button color still gets links a reader can read.
export function getReadableAccent(accent, background) {
	if (getContrast(accent, background) >= MIN_TEXT_CONTRAST) return accent;
	const target = getLuminance(background) > 0.5 ? BLACK : WHITE;
	for (let share = 0.05; share < 1; share += 0.05) {
		const shade = mixToward(accent, target, share);
		if (getContrast(shade, background) >= MIN_TEXT_CONTRAST) return shade;
	}
	return target;
}

export function isImageUrl(value) {
	return IMAGE_URL_PATTERN.test(String(value ?? ""));
}

export function getBrandProblem(brand = {}) {
	if (brand.theme && !THEME_IDS.includes(brand.theme)) return `Theme should be one of ${THEME_IDS.join(", ")}`;
	if (brand.fontPair && !FONT_PAIR_IDS.includes(brand.fontPair)) return `Font pair should be one of ${FONT_PAIR_IDS.join(", ")}`;
	if (brand.headerUrl && !isImageUrl(brand.headerUrl)) return "Header image must be an https:// link";
	return null;
}

// Everything the email and the website need of a newsletter's brand, with defaults for what it hasn't set.
// isCustom: the writer chose an accent or a font pair, so the email styles its links and headings itself; without one
// the email stays as it always was. assetBase: where a path like /logos/a.png is served, for the email's absolute links.
export function getBrand(newsletter, { assetBase = "" } = {}) {
	const brand = newsletter?.brand ?? {};
	const theme = THEME_IDS.includes(brand.theme) ? brand.theme : DEFAULT_THEME;
	const fontPair = FONT_PAIR_IDS.includes(brand.fontPair) ? brand.fontPair : DEFAULT_FONT_PAIR;
	const hasAccent = ACCENT_PATTERN.test(newsletter?.accentColor ?? "");
	const accent = hasAccent ? getAccent(newsletter) : DEFAULT_ACCENT;
	const toAbsolute = (url) => (/^\//.test(url ?? "") ? (assetBase ? `${assetBase}${url}` : "") : isImageUrl(url) ? url : "");
	const linkOnDark = getReadableAccent(accent, DARK_PAGE);
	// On a dark page a deep color would sink into it, so its buttons take the lighter shade the links use.
	const accentDark = getContrast(accent, DARK_PAGE) >= MIN_SHAPE_CONTRAST ? accent : linkOnDark;
	return {
		theme,
		fontPair,
		fonts: FONT_PAIRS[fontPair],
		accent,
		accentOn: getTextOn(accent),
		accentDark,
		accentDarkOn: getTextOn(accentDark),
		linkOnLight: getReadableAccent(accent, LIGHT_PAGE),
		linkOnDark,
		hasAccent,
		logoUrl: toAbsolute(newsletter?.imageUrl),
		headerUrl: toAbsolute(brand.headerUrl),
		hasEmailLogo: Boolean(brand.emailLogo),
		// The line under the name ("by QuoteSweep") in the website's header, the email's header and the share card.
		publisher: String(brand.publisher ?? "").trim().slice(0, 80),
		isCustom: hasAccent || fontPair !== DEFAULT_FONT_PAIR,
	};
}
