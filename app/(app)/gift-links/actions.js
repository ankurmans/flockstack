"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const whole = (value) => (String(value ?? "").trim() === "" ? undefined : Number(value));

export async function saveGiftLinkSettings(_state, formData) {
	const { failure } = await runDashboardAction("set_gift_links", {
		id: String(formData.get("newsletter") ?? ""),
		enabled: formData.get("enabled") === "on",
		perReaderPerMonth: whole(formData.get("perReaderPerMonth")),
		opensPerLink: whole(formData.get("opensPerLink")),
		days: whole(formData.get("days")),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/gift-links");
	return { ok: true };
}

export async function makeGiftLink(_state, formData) {
	const { output, failure } = await runDashboardAction("create_gift_link", {
		newsletter: String(formData.get("newsletter") ?? ""),
		campaign: String(formData.get("campaign") ?? ""),
		opens: whole(formData.get("opens")),
		days: whole(formData.get("days")),
		note: String(formData.get("note") ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/gift-links");
	return { ok: true, url: output.url };
}

export async function revokeGiftLink(id) {
	const { failure } = await runDashboardAction("revoke_gift_link", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/gift-links");
	return { ok: true };
}
