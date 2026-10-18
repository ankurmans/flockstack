import "server-only";
import { revalidatePath } from "next/cache";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { slugify } from "@/lib/slug";
import Product from "@/models/Product";

export const PRODUCT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
// A request body is held in memory while it is stored, and a Worker has 128 MB.
export const MAX_PRODUCT_FILE_BYTES = 15 * 1024 * 1024;

// A slug is unique within its newsletter: /shop/<slug>.
export async function uniqueProductSlug({ accountId, newsletterId, base, exceptId }) {
	const root = slugify(base, 60) || "product";
	for (let suffix = 1; suffix < 100; suffix += 1) {
		const slug = suffix === 1 ? root : `${root}-${suffix}`;
		const taken = await Product.exists({ accountId, newsletterId, slug, ...(exceptId && { _id: { $ne: exceptId } }) });
		if (!taken) return slug;
	}
	return `${root}-${Date.now()}`;
}

export function getProductUrl({ newsletter, product }) {
	if (!newsletter?.archiveEnabled || product.status !== "active") return null;
	return getArchiveUrls(newsletter).absoluteProduct(product.slug);
}

// The shop and product pages are cached with the archive's.
export function revalidateShop() {
	revalidatePath("/archive/[slug]", "layout");
}

// What a product can be sold for, and whether it can be sold now.
export function getProductProblem(product) {
	if (!product.file?.key) return "Upload the file buyers get";
	if (!product.title?.trim()) return "Add a title";
	return null;
}
