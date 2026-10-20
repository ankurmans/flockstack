"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { MIN_PRICE, readPriceCents, readProductSlug, runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function refresh(id) {
	revalidatePath("/products");
	if (id) revalidatePath(`/products/${id}`);
}

const PRICE_ERROR = { error: `Enter a price of ${MIN_PRICE} or more, like 19 or 19.50` };

// The action names its fields as the API does; the form's labels are these. status: the sentence says it all.
const FIELD_LABELS = { title: "Title", description: "Description", slug: "Page address", imageUrl: "Cover image", status: "" };

function toProductError(failure) {
	const message = failure.message
		.split("; ")
		.map((part) => {
			const [, field, rest] = /^(\w+): (.+)$/s.exec(part) ?? [];
			if (!Object.hasOwn(FIELD_LABELS, field ?? "")) return part;
			return FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${rest[0].toLowerCase()}${rest.slice(1)}` : `${rest[0].toUpperCase()}${rest.slice(1)}`;
		})
		.join("; ")
		.replace("uses the slug ", "uses the page address /shop/");
	return toFormError({ ...failure, message });
}

export async function createProduct(_state, formData) {
	const priceCents = readPriceCents(formData.get("price"));
	if (Number.isNaN(priceCents)) return PRICE_ERROR;
	const { output, failure } = await runDashboardAction("create_product", {
		newsletter: String(formData.get("newsletter") ?? "") || undefined,
		title: String(formData.get("title") ?? ""),
		priceCents,
		currency: String(formData.get("currency") ?? "usd"),
		description: String(formData.get("description") ?? "") || undefined,
	});
	if (failure) return toProductError(failure);
	refresh();
	redirect(`/products/${output.id}`);
}

export async function saveProduct(_state, formData) {
	const id = String(formData.get("id") ?? "");
	const priceCents = readPriceCents(formData.get("price"));
	if (Number.isNaN(priceCents)) return PRICE_ERROR;
	const slug = readProductSlug(formData.get("slug"));
	if (slug === null) return { error: "Page address: use letters or digits, like bird-stickers" };
	const { output, failure } = await runDashboardAction("update_product", {
		id,
		title: String(formData.get("title") ?? ""),
		description: String(formData.get("description") ?? ""),
		priceCents,
		currency: String(formData.get("currency") ?? "usd"),
		slug: slug || undefined,
		imageUrl: String(formData.get("imageUrl") ?? "").trim(),
	});
	if (failure) return toProductError(failure);
	refresh(id);
	return { ok: true, slug: output.slug };
}

export async function publishProduct(id) {
	const { failure } = await runDashboardAction("update_product", { id: String(id), status: "active" });
	refresh(id);
	return failure ? toProductError(failure) : { ok: true };
}

// Back to a draft: off sale, or out of the archive.
export async function unpublishProduct(id) {
	const { failure } = await runDashboardAction("update_product", { id: String(id), status: "draft" });
	refresh(id);
	return failure ? toProductError(failure) : { ok: true };
}

export async function archiveProduct(id) {
	const { failure } = await runDashboardAction("archive_product", { id: String(id) });
	refresh(id);
	return failure ? toProductError(failure) : { ok: true };
}
