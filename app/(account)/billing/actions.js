"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toBillingError, toFormError } from "@/lib/actions/dashboard";

// The billing page says it itself when the input was wrong or billing is off on this server.
const BILLING_PAGE_CODES = new Set(["validation_failed", "billing_off"]);

// Without a paid plan: Stripe Checkout. With one: Stripe's page to confirm the change.
export async function choosePlan(formData) {
	const interval = formData.get("interval") === "year" ? "year" : "month";
	const { output, failure } = await runDashboardAction("change_plan", { plan: String(formData.get("plan") ?? ""), interval });
	if (BILLING_PAGE_CODES.has(failure?.code)) redirect("/billing");
	redirect(failure ? `/billing?interval=${interval}&error=${toBillingError(failure)}` : output.url);
}

// The extra emails limit, typed with or without thousands separators.
export async function saveExtraEmailsLimit(_state, formData) {
	const text = String(formData.get("limit") ?? "").replace(/[\s,]/g, "");
	const limit = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(limit)) return { error: "Type a number of emails, or 0 for none" };
	const { output, failure } = await runDashboardAction("set_extra_emails_limit", { limit });
	if (failure) return toFormError(failure);
	revalidatePath("/billing");
	return { ok: true, limit: output.limit };
}

// Polar's checkout for the dedicated IP add-on.
export async function addDedicatedIp() {
	const { output, failure } = await runDashboardAction("add_dedicated_ip", {});
	if (failure) redirect(failure.code === "conflict" || BILLING_PAGE_CODES.has(failure.code) ? "/billing" : `/billing?error=${toBillingError(failure)}`);
	redirect(output.url);
}

export async function openBillingPortal() {
	const { output, failure } = await runDashboardAction("open_billing_portal", {});
	if (failure) redirect(failure.code === "conflict" || BILLING_PAGE_CODES.has(failure.code) ? "/billing" : `/billing?error=${toBillingError(failure)}`);
	redirect(output.url);
}
