"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// A new page starts as a draft with its title; the editor opens on it.
export async function createPage(newsletterId, title) {
	const { output, failure } = await runDashboardAction("create_page", { newsletter: String(newsletterId ?? ""), title: String(title ?? "").trim() });
	if (failure) return toFormError(failure);
	revalidatePath("/website");
	redirect(`/website/pages/${output.id}`);
}

export async function savePage(id, fields) {
	const { output, failure } = await runDashboardAction("update_page", {
		id: String(id ?? ""),
		title: String(fields?.title ?? "").trim(),
		slug: String(fields?.slug ?? "").trim(),
		description: String(fields?.description ?? "").trim(),
		format: "rich",
		content: String(fields?.content ?? ""),
		status: fields?.status === "published" ? "published" : "draft",
	});
	if (failure) return toFormError(failure);
	revalidatePath("/website");
	revalidatePath(`/website/pages/${id}`);
	return { ok: true, savedAt: Date.now(), page: output };
}

export async function deletePage(id) {
	const { failure } = await runDashboardAction("delete_page", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/website");
	redirect("/website");
}

// The navigation bar, replaced by the list sent.
export async function saveNavigation(newsletterId, items) {
	const { output, failure } = await runDashboardAction("update_navigation", {
		newsletter: String(newsletterId ?? ""),
		items: (Array.isArray(items) ? items : []).map((item) => ({
			...(item.id && { id: String(item.id) }),
			kind: String(item.kind ?? ""),
			...(item.label && { label: String(item.label) }),
			...(item.kind === "page" && { page: String(item.page ?? "") }),
			...(item.kind === "tag" && { tag: String(item.tag ?? "") }),
			...(item.kind === "link" && { url: String(item.url ?? "") }),
		})),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/website");
	return { ok: true, savedAt: Date.now(), items: output.items };
}
