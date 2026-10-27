import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { CURRENCIES, MAX_PRICE_CENTS, MIN_PRICE_CENTS } from "@/lib/payments/config";
import { checkSponsorshipDay, SPONSOR_LIMITS } from "@/lib/sponsorship-rules";
import { isObjectIdString } from "@/lib/validation";
import SponsorshipPlacement from "@/models/SponsorshipPlacement";
import SponsorshipSlot from "@/models/SponsorshipSlot";
import SponsorshipBooking from "@/models/SponsorshipBooking";

const conflict = message => actionError("conflict", message);
const revisionGuard = row => row.revision ? { revision: row.revision } : { $or: [{ revision: 0 }, { revision: { $exists: false } }] };

function assertPrice(amount, currency) {
	if (!Number.isSafeInteger(amount) || amount < MIN_PRICE_CENTS || amount > MAX_PRICE_CENTS || !CURRENCIES.includes(currency)) throw actionError("validation_failed", `Choose a supported currency and a price from ${MIN_PRICE_CENTS} to ${MAX_PRICE_CENTS} minor units`);
}

function assertNewsletter(account, newsletter) {
	if (String(scoped(account).accountId) !== String(newsletter.accountId)) throw actionError("not_found", "Newsletter not found");
}

export async function findSponsorshipRecord(Model, account, id) {
	const row = isObjectIdString(String(id ?? "")) ? await Model.findOne(scoped(account, { _id: id })).lean() : null;
	if (!row) throw actionError("not_found", "Sponsorship record not found");
	return row;
}

export async function publicSponsorshipSlots(account, newsletter, placements) {
	const allowed = new Set(placements.map(placement => String(placement._id)));
	const rows = await SponsorshipSlot.find(scoped(account, { newsletterId: newsletter._id, placementId: { $in: placements.map(placement => placement._id) }, status: "open", bookingId: null, day: { $gte: new Date(Date.now() - 86400000).toISOString().slice(0, 10) } })).sort({ day: 1, _id: 1 }).limit(100).lean();
	return rows.filter(slot => allowed.has(String(slot.placementId)) && !checkSponsorshipDay(slot.day, slot.timeZone));
}

export async function saveSponsorshipPlacement({ account, newsletter, input }) {
	assertNewsletter(account, newsletter);
	assertPaymentsReady(account);
	const name = String(input.name ?? "").trim(), description = String(input.description ?? "").trim();
	if (!name || name.length > 80 || description.length > 1000) throw actionError("validation_failed", "Use a placement name up to 80 characters and a description up to 1000 characters");
	assertPrice(input.amountMinor, input.currency);
	const values = { name, description, amountMinor: input.amountMinor, currency: input.currency, archived: input.archived === true };
	if (input.id) {
		const existing = await findSponsorshipRecord(SponsorshipPlacement, account, input.id);
		if (String(existing.newsletterId) !== String(newsletter._id)) throw actionError("not_found", "Placement not found");
		const saved = await SponsorshipPlacement.findOneAndUpdate(scoped(account, { _id: existing._id, newsletterId: newsletter._id }), { $set: values }, { new: true }).lean();
		if (!saved) throw conflict("This placement changed. Refresh and try again.");
		return saved;
	}
	if (await SponsorshipPlacement.countDocuments(scoped(account, { newsletterId: newsletter._id, archived: false })) >= SPONSOR_LIMITS.placements) throw conflict("This newsletter has 10 active placement types. Archive one before creating another.");
	return (await SponsorshipPlacement.create({ accountId: scoped(account).accountId, newsletterId: newsletter._id, ...values })).toObject();
}

// Opening a date is commercial inventory only. It never creates, schedules, queues or publishes a campaign.
export async function saveSponsorshipSlot({ account, newsletter, input }) {
	assertNewsletter(account, newsletter);
	const placement = await findSponsorshipRecord(SponsorshipPlacement, account, input.placementId);
	if (String(placement.newsletterId) !== String(newsletter._id)) throw actionError("not_found", "Placement not found");
	if (placement.archived) throw conflict("This placement is archived");
	const problem = checkSponsorshipDay(input.day, input.timeZone);
	if (problem) throw actionError("validation_failed", problem);
	const amountMinor = input.amountMinor ?? placement.amountMinor, currency = input.currency ?? placement.currency;
	assertPrice(amountMinor, currency);
	const filter = scoped(account, { newsletterId: newsletter._id, placementId: placement._id, day: input.day });
	const values = { timeZone: input.timeZone, placementName: placement.name, amountMinor, currency, status: input.open === false ? "closed" : "open" };
	for (let attempt = 0; attempt < 8; attempt++) {
		const row = await SponsorshipSlot.findOne(filter).lean();
		if (!row) {
			try { return (await SponsorshipSlot.create({ ...filter, ...values })).toObject(); }
			catch (error) { if (error?.code === 11000) continue; throw error; }
		}
		if (row.status === "reserved" || row.bookingId) throw conflict("This date is reserved. Resolve its booking before changing availability or price.");
		const result = await SponsorshipSlot.findOneAndUpdate(scoped(account, { _id: row._id, ...revisionGuard(row), status: { $in: ["open", "closed"] }, bookingId: null }), { $set: values, $inc: { revision: 1 } }, { new: true }).lean();
		if (result) return result;
	}
	throw conflict("This date changed. Refresh and try again.");
}

function sameQuote(slot, booking) {
	return String(slot.newsletterId) === String(booking.newsletterId) && String(slot.placementId) === String(booking.placementId) && slot.day === booking.day && slot.timeZone === booking.timeZone && slot.amountMinor === booking.amountMinor && slot.currency === booking.currency;
}

// Slot reservation wins on one row. An interrupted booking update is recovered by accepting that same reservation;
// cancellation releases only its own reservation, never another buyer's. No invoice or send runs inside these retries.
export async function acceptSponsorshipBooking({ account, bookingId }) {
	assertPaymentsReady(account);
	for (let attempt = 0; attempt < 8; attempt++) {
		const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
		if (!booking.verifiedAt || !["requested", "accepted"].includes(booking.status)) throw conflict("Only a verified, unbilled sponsorship request can be accepted");
		const slot = await findSponsorshipRecord(SponsorshipSlot, account, booking.slotId);
		if (!sameQuote(slot, booking)) throw conflict("The date, zone or price changed. Ask the sponsor to make a new request.");
		if (slot.status === "reserved" && String(slot.bookingId) !== String(booking._id) || slot.status === "closed") throw conflict("This placement date is no longer available");
		if (slot.status === "open") {
			const placement = await findSponsorshipRecord(SponsorshipPlacement, account, slot.placementId);
			if (String(placement.newsletterId) !== String(booking.newsletterId) || placement.archived || checkSponsorshipDay(slot.day, slot.timeZone)) throw conflict("This placement date is no longer open for requests");
			const won = await SponsorshipSlot.updateOne(scoped(account, { _id: slot._id, ...revisionGuard(slot), status: "open", bookingId: null }), { $set: { status: "reserved", bookingId: booking._id }, $inc: { revision: 1 } });
			if (!won.matchedCount) continue;
		}
		const current = await findSponsorshipRecord(SponsorshipBooking, account, booking._id);
		if (current.status === "canceled") {
			await SponsorshipSlot.updateOne(scoped(account, { _id: slot._id, status: "reserved", bookingId: booking._id }), { $set: { status: "open" }, $unset: { bookingId: 1 }, $inc: { revision: 1 } });
			throw conflict("This request was canceled");
		}
		if (current.status === "accepted") return current;
		if (current.status !== "requested" || !current.verifiedAt) throw conflict("This request changed before it was accepted");
		const saved = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: current._id, status: "requested", ...revisionGuard(current) }), { $set: { status: "accepted", acceptedAt: new Date() }, $inc: { revision: 1 } }, { new: true }).lean();
		if (saved) return saved;
	}
	throw conflict("This request changed. Refresh and try again.");
}
