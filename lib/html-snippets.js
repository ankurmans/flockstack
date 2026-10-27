import { filterAudienceBlocks } from "./audience-blocks.js";
import { cleanRichHtml } from "./clean-html.js";
import { findElements, readAttribute, splitAtPaywall } from "./editor-blocks.js";
export const MAX_SNIPPET_CHARS = 20000;
export function readHtmlSnippet(encoded) {
	try {
		if (typeof encoded !== "string" || encoded.length > MAX_SNIPPET_CHARS * 9) return "";
		const source = decodeURIComponent(encoded);
		return source.length <= MAX_SNIPPET_CHARS ? source : "";
	} catch { return ""; }
}
export function cleanHtmlSnippet(source) {
	// A snippet is plain rich markup. Editor markers inside it cannot become paywalls, embeds, feeds or nested snippets.
	return splitAtPaywall(filterAudienceBlocks(cleanRichHtml(source)).html).before.replace(/\sdata-[a-z][a-z0-9-]*(?:="[^"]*")?/gi, "");
}
export function expandHtmlSnippets(html) {
	const source = String(html ?? "");
	if (!/\sdata-html=/i.test(source)) return source;
	const blocks = findElements(source, (tag, name) => name === "div" && /\sdata-html=/i.test(tag));
	let result = ""; let cursor = 0;
	for (const block of blocks) {
		result += source.slice(cursor, block.start) + cleanHtmlSnippet(readHtmlSnippet(readAttribute(block.tag, "data-html")));
		cursor = block.end;
	}
	return result + source.slice(cursor);
}
