"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

function toCents(value) {
	const text = String(value ?? "").trim();
	if (!text) return 0;
	const amount = Number(text.replace(",", "."));
	return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN;
}

// Stripe's own page for the account owner to connect an account, or finish connecting it.
export async function connectStripe() {
	const { output, failure } = await runDashboardAction("connect_payments", {});
	if (failure) redirect(`/payments?error=${failure.code === "unavailable" ? "unavailable" : "connect"}`);
	redirect(output.url);
}

export async function refreshPayments() {
	const { failure } = await runDashboardAction("get_payments_status", { refresh: true });
	revalidatePath("/payments");
	return failure ? toFormError(failure) : { ok: true };
}

export async function savePaidTier(_state, formData) {
	const monthlyCents = toCents(formData.get("monthly"));
	const yearlyCents = toCents(formData.get("yearly"));
	if (Number.isNaN(monthlyCents) || Number.isNaN(yearlyCents)) return { error: "Enter prices like 8 or 8.50, or leave a plan empty" };
	const { failure } = await runDashboardAction("set_paid_tier", {
		id: String(formData.get("newsletterId") ?? ""),
		enabled: formData.get("enabled") === "on",
		monthlyCents,
		yearlyCents,
		currency: String(formData.get("currency") ?? "usd"),
		trialDays: Number.parseInt(String(formData.get("trialDays") ?? "0"), 10) || 0,
		pitch: String(formData.get("pitch") ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}
