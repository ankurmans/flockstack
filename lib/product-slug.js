import { slugify } from "@/lib/slug";

// A product's page is /shop/<slug> on its newsletter's site, and its slug is unique within the newsletter.
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const MAX_PRODUCT_SLUG_LENGTH = 80;

// Kept for pages the shop has or may have beside its products, so no product takes an address the shop needs.
export const RESERVED_PRODUCT_SLUGS = new Set(["cart", "checkout", "download", "downloads", "orders", "subscribe", "success"]);

// What someone typed as a page address, the way it goes in a link: "Bird Stickers Two" is bird-stickers-two.
export function toProductSlug(value) {
	return slugify(value, MAX_PRODUCT_SLUG_LENGTH);
}

// Why a slug can't be a product's address, in the form's words, or null.
export function getProductSlugProblem(slug) {
	if (!PRODUCT_SLUG_PATTERN.test(slug ?? "")) return "Use letters, digits and dashes, like bird-stickers";
	if (RESERVED_PRODUCT_SLUGS.has(slug)) return `/shop/${slug} is kept for the shop's own pages. Pick another address`;
	return null;
}
