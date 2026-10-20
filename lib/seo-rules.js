// The search settings an owner controls: per issue (models/Campaign.js seo) and per newsletter (jsonLd). Pure, so the
// dashboard's forms, the actions and the pages read the same limits.
export const SEO_LIMITS = { title: 120, description: 320, image: 500, jsonLd: 20_000, jsonLdBlocks: 5, jsonLdDepth: 12 };
const IMAGE_PATTERN = /^(https:\/\/[^\s"'<>]{4,490}|\/[\w\-./]{1,200})$/;

// What is wrong with an issue's search settings, or null. Empty fields are fine: they fall back to the issue's own.
export function getSeoProblem({ title = "", description = "", image = "" }) {
	if (title.length > SEO_LIMITS.title) return `The SEO title can be ${SEO_LIMITS.title} characters at most`;
	if (description.length > SEO_LIMITS.description) return `The meta description can be ${SEO_LIMITS.description} characters at most`;
	if (image && !IMAGE_PATTERN.test(image)) return "The social image has to be an https:// link";
	return null;
}

function getDepth(value, depth = 0) {
	if (depth > SEO_LIMITS.jsonLdDepth) return depth;
	if (Array.isArray(value)) return Math.max(depth, ...value.map((item) => getDepth(item, depth + 1)));
	if (value && typeof value === "object") return Math.max(depth, ...Object.values(value).map((item) => getDepth(item, depth + 1)));
	return depth;
}

function isNode(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (typeof value["@type"] === "string" || Array.isArray(value["@type"]) || Array.isArray(value["@graph"]));
}

// A newsletter's own structured data (an organization, an FAQ, an event): JSON text of one block or a list of up to
// 5, each with an @type or an @graph, 20,000 characters at most. { text, blocks } with the text compact as it is
// stored, or { problem }. Empty is no structured data.
export function checkJsonLd(value) {
	const source = String(value ?? "").trim();
	if (!source) return { text: "", blocks: [] };
	if (source.length > SEO_LIMITS.jsonLd) return { problem: `The structured data can be ${SEO_LIMITS.jsonLd.toLocaleString("en-US")} characters at most` };
	let parsed;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		return { problem: `The structured data isn't valid JSON: ${String(error.message).slice(0, 120)}` };
	}
	const blocks = Array.isArray(parsed) ? parsed : [parsed];
	if (blocks.length === 0 || blocks.length > SEO_LIMITS.jsonLdBlocks) return { problem: `Add 1 to ${SEO_LIMITS.jsonLdBlocks} blocks` };
	if (!blocks.every(isNode)) return { problem: 'Each block is an object with an "@type" (or an "@graph" list)' };
	if (getDepth(parsed) > SEO_LIMITS.jsonLdDepth) return { problem: "The structured data is nested too deeply" };
	return { text: JSON.stringify(parsed), blocks: blocks.map((block) => (block["@context"] ? block : { "@context": "https://schema.org", ...block })) };
}

export function getJsonLdProblem(value) {
	return checkJsonLd(value).problem ?? null;
}

// JSON for a script tag: "<" is escaped so a string can't end the tag or open a comment inside it, and the two line
// separators JavaScript counts as line ends are escaped too.
export function toScriptJson(data) {
	return JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

// The stored compact JSON, indented for editing.
export function formatJsonLd(text) {
	try {
		return text ? JSON.stringify(JSON.parse(text), null, 2) : "";
	} catch {
		return String(text ?? "");
	}
}
