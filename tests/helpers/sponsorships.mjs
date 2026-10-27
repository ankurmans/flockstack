import { randomUUID } from "node:crypto";
import { createSeller } from "./shop.mjs";
import { shiftDateKey, toDateKey } from "../../lib/time-zone.js";
let counter = 0;

export async function sponsorshipModels() {
	return { inventory: await import("../../lib/sponsorship-inventory.js"), bookings: await import("../../lib/sponsorship-bookings.js"), links: await import("../../lib/sponsorship-links.js"), Placement: (await import("../../models/SponsorshipPlacement.js")).default, Slot: (await import("../../models/SponsorshipSlot.js")).default, Booking: (await import("../../models/SponsorshipBooking.js")).default, Newsletter: (await import("../../models/Newsletter.js")).default, Contact: (await import("../../models/Contact.js")).default, Account: (await import("../../models/Account.js")).default };
}
export async function sponsorshipSeller(m, fake) {
	const user = await createSeller(`sponsor-publisher${++counter}@example.com`, { fake });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { sponsorships: { enabled: true } } });
	const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const placement = await m.inventory.saveSponsorshipPlacement({ account: user.account, newsletter, input: { name: "Main sponsor", description: "One labeled placement", amountMinor: 25000, currency: "usd" } });
	const slot = await m.inventory.saveSponsorshipSlot({ account: user.account, newsletter, input: { placementId: String(placement._id), day: shiftDateKey(toDateKey(new Date(), "UTC"), 7), timeZone: "UTC" } });
	return { user, newsletter, placement, slot };
}
export async function sponsorRequest(m, state, extra = {}) {
	const input = { slotId: String(state.slot._id), email: "advertiser@example.com", brandName: "Example sponsor", externalId: randomUUID(), ...extra };
	const result = await m.bookings.requestSponsorship({ account: state.user.account, newsletter: state.newsletter, input });
	const booking = await m.Booking.findOne({ accountId: state.user.accountId, _id: result.id }).lean();
	const token = new URL(m.links.getSponsorshipVerificationLink(booking)).searchParams.get("token");
	return { input, result, booking, token };
}
export const sponsorCreative = { headline: "A useful sponsor", body: "A practical product for readers.", callToAction: "Learn more", url: "https://example.com/offer" };
