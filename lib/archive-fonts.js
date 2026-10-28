import localFont from "next/font/local";

// The web fonts of the grotesk font pair (lib/brand.js), served by FlockStack itself from app/archive/fonts (SIL Open Font
// License, its text beside them): no request to Google. Every archive page declares them, but a browser downloads a font only
// for text set in it, and only a grotesk newsletter's stylesheet names them (lib/site-themes.js). No preload: it would fetch them
// on every newsletter's pages.
const hostGrotesk = localFont({ src: "../app/archive/fonts/host-grotesk-latin-wght-normal.woff2", weight: "300 800", display: "swap", preload: false });
const inter = localFont({ src: "../app/archive/fonts/inter-latin-wght-normal.woff2", weight: "100 900", display: "swap", preload: false });

// Each web font's name in FONT_PAIRS to the family it is served as.
export const WEB_FONT_FAMILIES = {
	"Host Grotesk": hostGrotesk.style.fontFamily,
	Inter: inter.style.fontFamily,
};
