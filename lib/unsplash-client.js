// The editor's content for a stock photo's credit line: "Photo by <photographer> on Unsplash", italic, both linked.
export function creditContent({ photographer, unsplashUrl }) {
	const italic = { type: "italic" };
	const piece = (text, href) => ({
		type: "text",
		text,
		marks: href ? [italic, { type: "link", attrs: { href } }] : [italic],
	});
	return {
		type: "paragraph",
		content: [piece("Photo by "), piece(photographer.name || "a photographer", photographer.url), piece(" on "), piece("Unsplash", unsplashUrl)],
	};
}
