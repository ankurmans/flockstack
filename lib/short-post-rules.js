import { actionError } from "./actions/errors.js";
import { hasAudienceBlocks } from "./audience-blocks.js";
import { hasPaywallBreak } from "./editor-blocks.js";
import { markdownToHtml } from "./markdown.js";
import { htmlToText } from "./render-email.js";

export const SHORT_POST_CHARACTERS = 2000;

export function assertShortPostInput(input) {
	if (input.subject !== undefined || input.previewText !== undefined || input.template || input.abTest || (input.publishTo && input.publishTo !== "web") || (input.audience && input.audience !== "all") || input.paidTier || input.segment || input.segments?.length || input.excludeSegments?.length || input.listIds?.length || input.excludeListIds?.length) {
		throw actionError("validation_failed", "A short post has no title, email, audience test or subscriber targeting. Use a newsletter issue for those.");
	}
}

// The excerpt names the record and its search/share metadata; it is never a visible post title.
export function shortPostFields(content) {
	if (content.format === "html") throw actionError("validation_failed", "Short posts use Markdown or rich text, not an HTML email document");
	const source = content.format === "markdown" ? content.markdown ?? "" : content.html ?? "";
	if (Buffer.byteLength(source, "utf8") > 20_000) throw actionError("validation_failed", "The short post is too large; use a newsletter issue for longer content");
	const html = content.format === "markdown" ? markdownToHtml(source) : source;
	if (hasAudienceBlocks(html) || hasPaywallBreak(html) || /\bdata-rss\b/i.test(html)) throw actionError("validation_failed", "Short posts are public and cannot contain paid, audience-specific or live RSS blocks");
	const text = htmlToText(html).replace(/\s+/g, " ").trim();
	if ([...text].length > SHORT_POST_CHARACTERS) throw actionError("validation_failed", `A short post can contain up to ${SHORT_POST_CHARACTERS.toLocaleString("en-US")} characters`);
	return { subject: [...text].slice(0, 120).join("").trim() || "Short post", previewText: [...text].slice(0, 300).join("").trim() };
}
