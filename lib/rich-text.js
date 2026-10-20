import { decodeEntities, escapeText } from "./editor-blocks.js";

// Short pieces of an issue that are written in a form's text box, not in the editor (a series' introduction, a newsletter's
// header and footer): plain paragraphs separated by a blank line, or HTML when it holds tags.
export function textToRich(text) {
	const source = String(text ?? "").trim();
	if (!source) return "";
	if (/<[a-z][^>]*>/i.test(source)) return source;
	return source
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p>${escapeText(paragraph).replaceAll("\n", "<br>")}</p>`)
		.join("");
}

// What the text box shows for stored rich text: paragraphs when it is only paragraphs, the HTML otherwise.
export function richToText(html) {
	const source = String(html ?? "").trim();
	if (!source) return "";
	const isPlain = /^(?:<p>(?:[^<]|<br\s*\/?>)*<\/p>)+$/i.test(source);
	if (!isPlain) return source;
	return decodeEntities(source.replace(/<\/p><p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?p>/gi, "")).trim();
}
