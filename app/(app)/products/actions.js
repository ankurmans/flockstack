"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The forms take dollars (or euros…) with decimals; the actions take the currency's smallest unit.
function toCents(value) {
	const amount = Number(String(value ?? "").trim().replace(",", "."));
	return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN;
}

function refresh(id) {
	revalidatePath("/products");
	if (id) revalidatePath(`/products/${id}`);
}

const PRICE_ERROR = { error: "Enter a price, like 19 or 19.50" };

export async function createProduct(_state, formData) {
	const priceCents = toCents(formData.get("price"));
	if (Number.isNaN(priceCents)) return PRICE_ERROR;
	const { output, failure } = await runDashboardAction("create_product", {
		newsletter: String(formData.get("newsletter") ?? "") || undefined,
		title: String(formData.get("title") ?? ""),
		priceCents,
		currency: String(formData.get("currency") ?? "usd"),
		description: String(formData.get("description") ?? "") || undefined,
	});
	if (failure) return toFormError(failure);
	refresh();
	redirect(`/products/${output.id}`);
}

export async function saveProduct(_state, formData) {
	const id = String(formData.get("id") ?? "");
	const priceCents = toCents(formData.get("price"));
	if (Number.isNaN(priceCents)) return PRICE_ERROR;
	const { output, failure } = await runDashboardAction("update_product", {
		id,
		title: String(formData.get("title") ?? ""),
		description: String(formData.get("description") ?? ""),
		priceCents,
		currency: String(formData.get("currency") ?? "usd"),
		slug: String(formData.get("slug") ?? "").trim() || undefined,
		imageUrl: String(formData.get("imageUrl") ?? "").trim(),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, slug: output.slug };
}

export async function publishProduct(id) {
	const { failure } = await runDashboardAction("update_product", { id: String(id), status: "active" });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

// Back to a draft: off sale, or out of the archive.
export async function unpublishProduct(id) {
	const { failure } = await runDashboardAction("update_product", { id: String(id), status: "draft" });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

export async function archiveProduct(id) {
	const { failure } = await runDashboardAction("archive_product", { id: String(id) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}
