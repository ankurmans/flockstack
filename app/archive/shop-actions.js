"use server";

import { headers } from "next/headers";
import { connectDb } from "@/lib/db";
import { getClientIp } from "@/lib/rate-limit";
import { startPaidSubscription, startProductPurchase } from "@/lib/shop";
import { normalizeEmail } from "@/lib/validation";

// The shop's forms run on the newsletter's own host, like the signup form. Both resolve to { url } (Stripe Checkout) or
// { error }; the form sends the visitor on to the url.
export async function subscribePaid(_state, formData) {
	if (formData.get("website")) return { error: "This newsletter doesn't offer that plan" };
	await connectDb();
	return startPaidSubscription({
		newsletterSlug: String(formData.get("newsletter") ?? ""),
		tierId: String(formData.get("tier") ?? ""),
		option: String(formData.get("option") ?? formData.get("interval") ?? ""),
		email: String(formData.get("email") ?? ""),
		ip: getClientIp(await headers()),
	});
}

export async function buyProduct(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { error: "This product isn't for sale" };
	const email = String(formData.get("email") ?? "").trim();
	if (email && !normalizeEmail(email)) return { error: "Enter a valid email" };

	await connectDb();
	return startProductPurchase({
		newsletterSlug: String(formData.get("newsletter") ?? ""),
		productSlug: String(formData.get("product") ?? ""),
		email,
		addToList: formData.get("addToList") === "on",
		ip: getClientIp(await headers()),
	});
}
