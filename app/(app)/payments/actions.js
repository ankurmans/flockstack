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
		trialNoCard: formData.get("trialNoCard") === "on",
		supportersPublic: formData.get("supportersPublic") === "on",
		pitch: String(formData.get("pitch") ?? ""),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

function readCents(formData, name) {
	return readPriceCents(formData.get(name), { allowEmpty: true });
}

// A tier's form: create when it has no tierId, else change. Empty prices are plans not offered.
export async function saveTier(_state, formData) {
	const newsletterId = String(formData.get("newsletterId") ?? "");
	const tierId = String(formData.get("tierId") ?? "");
	const prices = { monthlyCents: readCents(formData, "monthly"), quarterlyCents: readCents(formData, "quarterly"), yearlyCents: readCents(formData, "yearly"), lifetimeCents: readCents(formData, "lifetime") };
	const pwywCents = readCents(formData, "pwyw");
	if (Object.values(prices).some(Number.isNaN) || Number.isNaN(pwywCents)) return { error: `Enter prices of ${MIN_PRICE} or more, like 8 or 8.50, or leave a plan empty` };
	const cap = Number.parseInt(String(formData.get("foundingCap") ?? ""), 10);
	const input = {
		id: newsletterId,
		name: String(formData.get("name") ?? ""),
		description: String(formData.get("description") ?? ""),
		benefits: String(formData.get("benefits") ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
		...prices,
		payWhatYouWant: pwywCents > 0 ? { minCents: pwywCents, interval: formData.get("pwywInterval") === "month" ? "month" : "year" } : null,
		founding: { enabled: formData.get("founding") === "on", cap: Number.isInteger(cap) && cap > 0 ? cap : null },
		...(tierId && { tierId, archived: formData.get("archived") === "on" }),
	};
	const { failure } = tierId ? await runDashboardAction("update_paid_tier", input) : await runDashboardAction("create_paid_tier", input);
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function deleteTier(newsletterId, tierId) {
	const { failure } = await runDashboardAction("delete_paid_tier", { id: String(newsletterId), tierId: String(tierId) });
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function moveTier(newsletterId, tierIds) {
	const { failure } = await runDashboardAction("reorder_paid_tiers", { id: String(newsletterId), tierIds });
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function savePledges(_state, formData) {
	const { failure } = await runDashboardAction("set_pledges", {
		id: String(formData.get("newsletterId") ?? ""),
		enabled: formData.get("enabled") === "on",
		noticeDays: Number.parseInt(String(formData.get("noticeDays") ?? "7"), 10) || 7,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function startPledgeCharging(_state, formData) {
	const { failure } = await runDashboardAction("start_pledge_charging", {
		id: String(formData.get("newsletterId") ?? ""),
		noticeDays: Number.parseInt(String(formData.get("noticeDays") ?? "7"), 10) || 7,
		honorPledgedPrice: formData.get("honorPledgedPrice") === "on",
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function stopPledgeCharging(newsletterId) {
	const { failure } = await runDashboardAction("stop_pledge_charging", { id: String(newsletterId) });
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function saveOffer(_state, formData) {
	const type = String(formData.get("type") ?? "percent");
	const value = Number(String(formData.get("value") ?? "").replace(",", "."));
	const trialDays = Number.parseInt(String(formData.get("trialDays") ?? ""), 10);
	const months = Number.parseInt(String(formData.get("durationMonths") ?? ""), 10);
	const limit = Number.parseInt(String(formData.get("maxRedemptions") ?? ""), 10);
	const expires = String(formData.get("expiresAt") ?? "").trim();
	if (type !== "trial" && !(value > 0)) return { error: type === "percent" ? "Enter how many percent come off, like 20" : "Enter how much comes off, like 5" };
	const duration = String(formData.get("duration") ?? "once");
	const { failure } = await runDashboardAction("create_offer", {
		id: String(formData.get("newsletterId") ?? ""),
		name: String(formData.get("name") ?? ""),
		type,
		...(type === "percent" && { percentOff: value }),
		...(type === "amount" && { amountOffCents: Math.round(value * 100) }),
		...(type !== "trial" && { duration, ...(duration === "repeating" && { durationMonths: months || 3 }) }),
		...(Number.isInteger(limit) && limit > 0 && { maxRedemptions: limit }),
		...(expires && { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() }),
		...(Number.isInteger(trialDays) && trialDays > 0 && { trialDays }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function switchOffer(offerId, active) {
	const { failure } = await runDashboardAction("update_offer", { id: String(offerId), active: Boolean(active) });
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function removeOffer(offerId) {
	const { failure } = await runDashboardAction("delete_offer", { id: String(offerId) });
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}

export async function saveBanner(_state, formData) {
	const offer = String(formData.get("offer") ?? "");
	const { failure } = await runDashboardAction("set_launch_banner", {
		id: String(formData.get("newsletterId") ?? ""),
		enabled: formData.get("enabled") === "on",
		text: String(formData.get("text") ?? "").trim() || undefined,
		offer: offer || null,
	});
	if (failure) return toFormError(failure);
	revalidatePath("/payments");
	return { ok: true };
}
