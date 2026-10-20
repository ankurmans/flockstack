export const MAX_TEMPLATES_PER_NEWSLETTER = 50;
export const MAX_SNIPPETS_PER_NEWSLETTER = 50;
export const MAX_SNIPPET_LENGTH = 20_000;
export const MAX_STYLE_LENGTH = 20_000;

// A newsletter's default style (models/Newsletter.js defaultStyle): what a new issue starts with. A header goes above
// and a footer below an empty paragraph the writer starts in; without either, a new issue is empty as before.
export function getStartingHtml(newsletter) {
	const { header = "", footer = "" } = newsletter?.defaultStyle ?? {};
	return header || footer ? `${header}<p></p>${footer}` : "";
}

// The same for an issue made by something other than a writer (a series): the content between the two.
export function withDefaultStyle(newsletter, html) {
	const { header = "", footer = "" } = newsletter?.defaultStyle ?? {};
	return `${header}${html}${footer}`;
}
