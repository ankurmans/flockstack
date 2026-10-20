import { slugify } from "./slug.js";

// The website's navigation bar: links to its pages, its list of issues, a tag's page or any https:// address, in the
// order the writer set. What is saved is the writer's list; what a visitor sees (navLinks) leaves out the pages that are
// drafts or gone.
export const NAV_KINDS = ["page", "link", "archive", "tag"];
export const MAX_NAV_ITEMS = 12;
export const MAX_NAV_LABEL = 40;
const LINK_PATTERN = /^https:\/\/[^\s"'<>]{4,490}$/;
const ID_PATTERN = /^[a-f0-9]{12}$/;
const DEFAULT_LABELS = { archive: "Archive" };

function newItemId() {
	return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The writer's list as saved: each item with an ID (kept when it has one) and only the fields its kind uses. pageIds: the
// IDs of the newsletter's pages. Answers { problem } in words, or { items }.
export function normalizeNavigation(input, { pageIds }) {
	if (input.length > MAX_NAV_ITEMS) return { problem: `Add at most ${MAX_NAV_ITEMS} links` };
	const items = [];
	for (const [index, raw] of input.entries()) {
		const where = `Link ${index + 1}`;
		const label = String(raw.label ?? "").trim();
		if (!NAV_KINDS.includes(raw.kind)) return { problem: `${where}: choose a page, a tag, the archive or a link` };
		if (label.length > MAX_NAV_LABEL) return { problem: `${where}: keep the label under ${MAX_NAV_LABEL} characters` };
		const id = ID_PATTERN.test(raw.id ?? "") ? raw.id : newItemId();
		if (raw.kind === "page") {
			const pageId = String(raw.pageId ?? "");
			if (!pageIds.has(pageId)) return { problem: `${where}: that page doesn't exist` };
			items.push({ id, kind: "page", pageId, ...(label && { label }) });
		} else if (raw.kind === "link") {
			const url = String(raw.url ?? "").trim();
			if (!LINK_PATTERN.test(url)) return { problem: `${where}: the address must start with https://` };
			if (!label) return { problem: `${where}: add a label` };
			items.push({ id, kind: "link", url, label });
		} else if (raw.kind === "tag") {
			const tag = slugify(raw.tag, 60);
			if (!tag) return { problem: `${where}: name a tag` };
			items.push({ id, kind: "tag", tag, ...(label && { label }) });
		} else {
			items.push({ id, kind: "archive", ...(label && { label }) });
		}
	}
	return { items };
}

// The links a visitor sees, in order. pages: the published ones as { _id, slug, title }. urls: getArchiveUrls().
export function getNavLinks(newsletter, pages, urls) {
	const byId = new Map(pages.map((page) => [String(page._id), page]));
	const links = [];
	for (const item of newsletter?.navigation ?? []) {
		if (item.kind === "page") {
			const page = byId.get(item.pageId);
			if (page) links.push({ id: item.id, label: item.label || page.title, href: urls.post(page.slug), isExternal: false });
		} else if (item.kind === "link") {
			links.push({ id: item.id, label: item.label, href: item.url, isExternal: true });
		} else if (item.kind === "tag") {
			links.push({ id: item.id, label: item.label || item.tag, href: urls.tag(item.tag), isExternal: false });
		} else {
			links.push({ id: item.id, label: item.label || DEFAULT_LABELS.archive, href: urls.issues, isExternal: false });
		}
	}
	return links;
}
