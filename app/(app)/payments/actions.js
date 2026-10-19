"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { MIN_PRICE, readPriceCents, runDashboardAction, toFormError } from "@/lib/actions/dashboard";

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
	// Empty is a plan not offered.
	const monthlyCents = readPriceCents(formData.get("monthly"), { allowEmpty: true });
	const yearlyCents = readPriceCents(formData.get("yearly"), { allowEmpty: true });
	if (Number.isNaN(monthlyCents) || Number.isNaN(yearlyCents)) {
		return { error: `Enter prices of ${MIN_PRICE} or more, like 8 or 8.50, or leave a plan empty` };
	}
	const enabled = formData.get("enabled") === "on";
	if (enabled && monthlyCents === 0 && yearlyCents === 0) return { error: "Set a monthly or a yearly price first" };
	const { failure } = await runDashboardAction("set_paid_tier", {
		id: String(formData.get("newsletterId") ?? ""),
		enabled,
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
