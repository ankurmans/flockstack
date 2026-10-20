import { ARCHIVE_SLUG_PATTERN, slugify } from "./slug.js";

// Custom pages (About, Sponsor, Contact): what a page is, with nothing that touches the database.
export const PAGE_STATUSES = ["draft", "published"];
export const MAX_PAGES_PER_NEWSLETTER = 25;
export const MAX_PAGE_TITLE = 120;
export const MAX_PAGE_DESCRIPTION = 300;
export const MAX_PAGE_BYTES = 200_000;

// The path a title suggests: /p/about-me.
export function slugFromTitle(title) {
	return slugify(title, 80);
}

export function getPageSlugProblem(slug) {
	if (!ARCHIVE_SLUG_PATTERN.test(slug ?? "")) return "slug: use lowercase letters, digits and dashes, 120 at most";
	return null;
}

export function getPageProblem({ title, slug, description, html }) {
	if (!title?.trim()) return "title: give the page a title";
	if (title.length > MAX_PAGE_TITLE) return `title: keep it under ${MAX_PAGE_TITLE} characters`;
	const slugProblem = getPageSlugProblem(slug);
	if (slugProblem) return slugProblem;
	if ((description ?? "").length > MAX_PAGE_DESCRIPTION) return `description: keep it under ${MAX_PAGE_DESCRIPTION} characters`;
	if (new TextEncoder().encode(html ?? "").length > MAX_PAGE_BYTES) return `content: a page can hold ${MAX_PAGE_BYTES / 1000} KB at most`;
	return null;
}
