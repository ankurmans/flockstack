// next build loads the fonts; in tests, each one is a font without a file.
function font({ variable = "" } = {}) {
	return { className: "", variable, style: { fontFamily: "serif" } };
}

export const Geist = font;
export const Geist_Mono = font;
export const Newsreader = font;
