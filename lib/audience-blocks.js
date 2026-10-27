import { findElements, readAttribute } from "./editor-blocks.js";
export const hasAudienceBlocks = (html) => { const text = String(html ?? ""); return /\sdata-access\b/i.test(text) && /<div\b[^>]*\sdata-access\b/i.test(text.slice(0, text.lastIndexOf(">") + 1)); };
function mayRead(tag, { readerTier = "free", readerTierId = null, tiers = [], previewAll = false }) {
	const access = readAttribute(tag, "data-access"); const minimum = readAttribute(tag, "data-min-tier");
	if (!["free", "paid"].includes(access)) return false;
	if (minimum && (access !== "paid" || !tiers.some(({ id }) => id === minimum))) return false;
	if (previewAll) return true;
	if (access === "free") return readerTier === "free";
	if (readerTier !== "paid" && readerTier !== "metered") return false;
	if (!minimum) return true;
	if (readerTier !== "paid") return false;
	const reader = tiers.findIndex(({ id }) => id === readerTierId); const floor = tiers.findIndex(({ id }) => id === minimum);
	return reader >= 0 && floor >= 0 && reader >= floor;
}
// Call after the rich cleaner. A malformed/unclosed guard fails closed, including its remaining text.
export function filterAudienceBlocks(html, options = {}, depth = 0) {
	const source = String(html ?? ""); if (!hasAudienceBlocks(source)) return { html: source, hiddenPaid: false };
	if (depth >= 30) return { html: "", hiddenPaid: true };
	const blocks = findElements(source, (tag, name) => name === "div" && /\sdata-access\b/i.test(tag));
	const starts = [...source.matchAll(/<div\b[^>]*\sdata-access\b[^>]*>/gi)];
	let covering = 0;
	for (const match of starts) {
		while (blocks[covering] && blocks[covering].end <= match.index) covering++;
		if (!blocks[covering] || match.index < blocks[covering].start) return { html: "", hiddenPaid: true };
	}
	let output = "", cursor = 0, hiddenPaid = false;
	for (const block of blocks) {
		output += source.slice(cursor, block.start);
		if (mayRead(block.tag, options)) { const inner = filterAudienceBlocks(block.inner, options, depth + 1); output += inner.html; hiddenPaid ||= inner.hiddenPaid; }
		else hiddenPaid ||= readAttribute(block.tag, "data-access") !== "free";
		cursor = block.end;
	}
	return { html: output + source.slice(cursor), hiddenPaid };
}
