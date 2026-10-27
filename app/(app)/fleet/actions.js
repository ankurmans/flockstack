"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function onboardBrands(_state, formData) {
	const domains = formData.getAll("domain").map((domain) => ({ domain: String(domain) }));
	const { output, failure } = await runDashboardAction("onboard_brand_domains", { domains });
	revalidatePath("/fleet");
	revalidatePath("/domains");
	return failure ? toFormError(failure) : { ok: true, domains: output.domains };
}

export async function resumeNewsletter(id) {
	const { failure } = await runDashboardAction("resume_newsletter_sending", { id: String(id) });
	revalidatePath("/fleet");
	return failure ? toFormError(failure) : { ok: true };
}

export async function recommendBrand(_state, formData) {
	const { failure } = await runDashboardAction("add_recommendation", {
		newsletter: String(formData.get("newsletter") ?? ""),
		slug: String(formData.get("slug") ?? ""),
		pitch: String(formData.get("pitch") ?? ""),
	});
	revalidatePath("/fleet");
	revalidatePath("/recommending");
	return failure ? toFormError(failure) : { ok: true };
}
