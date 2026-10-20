"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// Puts uploads in a folder (a new name makes the folder); an empty folder takes them out of theirs.
export async function moveMedia(ids, folder) {
	const { output, failure } = await runDashboardAction("move_media", { ids: Array.isArray(ids) ? ids.map(String) : [], folder: String(folder ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/media");
	return { ok: true, moved: output.moved };
}

export async function renameMediaFolder(folder, name) {
	const { failure } = await runDashboardAction("rename_media_folder", { folder: String(folder ?? ""), name: String(name ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/media");
	return { ok: true };
}
