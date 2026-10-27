"use server";
import { runDashboardAction } from "@/lib/actions/dashboard";
export async function importSubscribers(_state, formData) {
	let prices;
	try { prices = JSON.parse(String(formData.get("prices") ?? "{}")); } catch { return { error: "Use a JSON price-to-tier map" }; }
	const { output, failure } = await runDashboardAction("import_stripe_subscribers", { newsletter: String(formData.get("newsletter") ?? ""), subscriptions: String(formData.get("subscriptions") ?? "").split(/[\s,]+/).filter(Boolean), prices, apply: formData.get("mode") === "apply", consent: formData.get("consent") === "on" });
	return failure ? { error: failure.message } : { output };
}
