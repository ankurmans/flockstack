import { escapeHtml } from "./escape-html.js";
import { getLinkProblem } from "./link-check-rules.js";

// Editor blocks are also imported by newsletter defaults on every dashboard page. Keep the disclosure's six
// short labels here so those pages do not load the complete reader interface and error catalogs.
const DISCLOSURES = { en: "Sponsored", es: "Patrocinado", fr: "Sponsorisé", de: "Gesponsert", it: "Sponsorizzato", pt: "Patrocinado" };

const MARKER = /<div\s+data-sponsorship="([^"<>]{1,30000})"\s*>\s*<\/div>/gi;
const id = value => /^[a-f0-9]{24}$/.test(value ?? "");

export function readSponsorshipBlock(value) {
	try {
		const data = JSON.parse(decodeURIComponent(value));
		if (!id(data.id) || !/^[a-f0-9]{64}$/.test(data.hash ?? "") || !data.creative) return null;
		if (data.language !== undefined && !Object.hasOwn(DISCLOSURES, data.language)) return null;
		for (const [key, max] of [["headline", 120], ["body", 2000], ["callToAction", 60], ["url", 2000]]) if (typeof data.creative[key] !== "string" || !data.creative[key] || data.creative[key].length > max || /\{\{|\}\}/.test(data.creative[key])) return null;
		if (getLinkProblem(data.creative.url) || data.creative.assetId && !id(data.creative.assetId)) return null;
		if (data.imageUrl && (!data.creative.assetId || getLinkProblem(data.imageUrl) || !new URL(data.imageUrl).pathname.match(new RegExp(`^/sponsor-assets/${data.creative.assetId}/[A-Za-z0-9_-]{43}$`)))) return null;
		return data;
	} catch { return null; }
}

export function findSponsorshipBlocks(html) {
	return [...String(html ?? "").matchAll(MARKER)].map(match => ({ start: match.index, end: match.index + match[0].length, encoded: match[1], data: readSponsorshipBlock(match[1]) }));
}

export function sponsorshipBlockHtml(data) {
	return `<div data-sponsorship="${escapeHtml(encodeURIComponent(JSON.stringify(data)))}"></div>`;
}

// Reserved positions are separate from the ordinary 0..99 links and remain the same when audience or paywall
// filtering removes other blocks. A booking's place comes from the saved source, not a recipient's rendered HTML.
export function sponsorshipLinkIndexes(html) {
	return new Map(findSponsorshipBlocks(html).filter(block => block.data).slice(0, 10).map((block, index) => [block.data.id, 100 + index]));
}

export function renderSponsorshipBlocks(html) {
	return String(html ?? "").replace(MARKER, (_match, encoded) => {
		const data = readSponsorshipBlock(encoded);
		if (!data) return "<p>Sponsor placement unavailable</p>";
		const { creative } = data;
		return `<div style="margin:24px 0;padding:20px;border:1px solid #d4d4d8;"><p style="font-size:12px;">${escapeHtml(DISCLOSURES[data.language] ?? DISCLOSURES.en)}</p>${data.imageUrl ? `<img src="${escapeHtml(data.imageUrl)}" alt="" width="600" style="max-width:100%;height:auto;">` : ""}<h3>${escapeHtml(creative.headline)}</h3><p>${escapeHtml(creative.body).replaceAll("\n", "<br>")}</p><p><a data-sponsor-booking="${data.id}" href="${escapeHtml(creative.url)}" rel="sponsored noopener">${escapeHtml(creative.callToAction)}</a></p></div>`;
	});
}

export function renderedSponsorshipIds(html) {
	return [...new Set([...String(html ?? "").matchAll(/<a\b[^>]*\sdata-sponsor-booking="([a-f0-9]{24})"[^>]*>/gi)].map(match => match[1]))];
}
