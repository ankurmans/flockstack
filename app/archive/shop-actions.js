"use server";

import { headers } from "next/headers";
import { connectDb } from "@/lib/db";
import { getClientIp } from "@/lib/rate-limit";
import { startGiftPurchase } from "@/lib/gifts";
import { startPledge } from "@/lib/pledges";
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
		offerCode: String(formData.get("offer") ?? ""),
		email: String(formData.get("email") ?? ""),
		ip: getClientIp(await headers()),
	});
}

// A reader pledges a price on a newsletter that isn't taking payments yet: Stripe's page saves a card and charges nothing.
export async function pledgeSupport(_state, formData) {
	if (formData.get("website")) return { error: "This newsletter doesn't take pledges" };
	await connectDb();
	return startPledge({
		newsletterSlug: String(formData.get("newsletter") ?? ""),
		tierId: String(formData.get("tier") ?? ""),
		option: String(formData.get("option") ?? ""),
		email: String(formData.get("email") ?? ""),
		ip: getClientIp(await headers()),
	});
}

// A reader buys a gift subscription for someone: Stripe Checkout for the payment, then the gift is emailed on the day they chose.
export async function buyGift(_state, formData) {
	if (formData.get("website")) return { error: "This newsletter doesn't sell gifts" };
	await connectDb();
	return startGiftPurchase({
		newsletterSlug: String(formData.get("newsletter") ?? ""),
		tierId: String(formData.get("tier") ?? ""),
		months: String(formData.get("months") ?? ""),
		recipientEmail: String(formData.get("recipientEmail") ?? ""),
		buyerEmail: String(formData.get("buyerEmail") ?? ""),
		buyerName: String(formData.get("buyerName") ?? ""),
		message: String(formData.get("message") ?? ""),
		deliverOn: String(formData.get("deliverOn") ?? ""),
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
