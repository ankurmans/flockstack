import "server-only";
import { getSponsorshipEmailCopy } from "@/lib/sponsorship-email-copy";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem, isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { getSignupProblem } from "@/lib/contacts";
import { getSponsorshipManagerLink, getSponsorshipVerificationLink, readSponsorshipToken } from "@/lib/sponsorship-links";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { checkSponsorCreative, checkSponsorshipDay } from "@/lib/sponsorship-rules";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import Newsletter from "@/models/Newsletter";
import SponsorshipAsset from "@/models/SponsorshipAsset";
import SponsorshipBooking from "@/models/SponsorshipBooking";
import SponsorshipPlacement from "@/models/SponsorshipPlacement";
import SponsorshipSlot from "@/models/SponsorshipSlot";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const missing = () => actionError("not_found", "This sponsorship link expired or is no longer available. Ask for a new email.");
const revisionGuard = row => row.revision ? { revision: row.revision } : { $or: [{ revision: 0 }, { revision: { $exists: false } }] };

export async function currentSponsorshipAccount(account, { change = false } = {}) {
	const current = await Account.findById(account?._id ?? account).lean();
	if (!current || isDeletionPending(current)) throw missing();
	if (change && getAccountSendProblem(current)) throw actionError("conflict", "Sponsorship changes aren't available right now. Ask the creator for help.");
	return current;
}

export async function readSponsorshipContext(token, kind = "manager") {
	const reference = readSponsorshipToken(token, kind);
	if (!reference) throw missing();
	const account = await currentSponsorshipAccount(reference.accountId);
	const booking = await SponsorshipBooking.findOne(scoped(account, { _id: reference.bookingId, newsletterId: reference.newsletterId })).lean();
	const newsletter = booking && await Newsletter.findOne(scoped(account, { _id: reference.newsletterId })).lean();
	if (!booking || !newsletter || (kind === "verify" ? booking.status !== "unverified" || booking.verificationVersion !== reference.version : !booking.verifiedAt || booking.managerVersion !== reference.version)) throw missing();
	return { account, newsletter, booking, reference };
}

async function emailVerification(account, newsletter, booking) {
	if (booking.status !== "unverified") return { sent: false, alreadyRequested: true };
	if (booking.requestEmailSentAt && Date.now() - +new Date(booking.requestEmailSentAt) < 60000) return { sent: false, alreadyRequested: true };
	if (await isRateLimited({ name: "sponsor-verification-email", key: limitKey(`${account._id}:${booking.email}`), limit: 3, window: "1 h" })) throw actionError("rate_limited", "Wait before requesting another sponsorship verification email");
	const { sendTransactionalEmail } = await import("@/lib/sending");
	const result = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: booking.email, ...getSponsorshipEmailCopy(newsletter, booking, "verify", getSponsorshipVerificationLink(booking)) });
	if (result.sent) await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id, status: "unverified" }), { $set: { requestEmailSentAt: new Date() } });
	return { sent: result.sent === true };
}

export async function requestSponsorship({ account, newsletter, input }) {
	account = await currentSponsorshipAccount(account, { change: true });
	if (String(newsletter.accountId) !== String(account._id)) throw actionError("not_found", "Newsletter not found");
	const live = await Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean();
	if (!live?.archiveEnabled || !live.sponsorships?.enabled) throw actionError("conflict", "This newsletter isn't taking sponsorship requests");
	assertPaymentsReady(account);
	const email = normalizeEmail(input.email ?? ""), brandName = String(input.brandName ?? "").trim();
	if (!email || !brandName || brandName.length > 120 || !uuid.test(input.externalId ?? "")) throw actionError("validation_failed", "Enter a buyer email, brand name up to 120 characters and a stable request UUID");
	const problem = await getSignupProblem(email);
	if (problem) throw actionError("validation_failed", problem);
	let booking = await SponsorshipBooking.findOne(scoped(account, { externalId: input.externalId })).lean();
	if (booking && (String(booking.newsletterId) !== String(newsletter._id) || String(booking.slotId) !== String(input.slotId) || booking.email !== email || booking.brandName !== brandName)) throw actionError("conflict", "This retry ID belongs to another sponsorship request");
	if (!booking) {
		if (await isRateLimited({ name: "sponsor-new-requests", key: String(account._id), limit: 60, window: "1 h" })) throw actionError("rate_limited", "This newsletter received too many recent sponsorship requests. Try later.");
		const slot = await findSponsorshipRecord(SponsorshipSlot, account, input.slotId);
		if (String(slot.newsletterId) !== String(newsletter._id)) throw actionError("not_found", "Placement date not found");
		const placement = await findSponsorshipRecord(SponsorshipPlacement, account, slot.placementId);
		if (String(placement.newsletterId) !== String(newsletter._id) || slot.status !== "open" || slot.bookingId || placement.archived || checkSponsorshipDay(slot.day, slot.timeZone)) throw actionError("conflict", "This sponsorship date is no longer available");
		try {
			booking = (await SponsorshipBooking.create({ accountId: account._id, newsletterId: newsletter._id, slotId: slot._id, placementId: placement._id, placementName: slot.placementName, day: slot.day, timeZone: slot.timeZone, amountMinor: slot.amountMinor, currency: slot.currency, email, brandName, externalId: input.externalId })).toObject();
		} catch (error) {
			if (error?.code !== 11000) throw error;
			booking = await SponsorshipBooking.findOne(scoped(account, { externalId: input.externalId })).lean();
			if (!booking || String(booking.slotId) !== String(slot._id) || booking.email !== email || booking.brandName !== brandName) throw actionError("conflict", "This retry ID belongs to another sponsorship request");
		}
	}
	const result = await emailVerification(account, live, booking);
	return { id: String(booking._id), status: booking.status, verificationSent: result.sent, alreadyRequested: result.alreadyRequested === true };
}

export async function verifySponsorshipRequest(token) {
	const { account, booking, newsletter, reference } = await readSponsorshipContext(token, "verify");
	await currentSponsorshipAccount(account, { change: true });
	const verified = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, status: "unverified", verificationVersion: reference.version }), { $set: { status: "requested", verifiedAt: new Date() }, $inc: { verificationVersion: 1, revision: 1 } }, { new: true }).lean();
	if (!verified) throw missing();
	// Only the recipient proving control of the verification email receives a buyer capability here.
	return { newsletter, booking: verified, managerUrl: getSponsorshipManagerLink(verified) };
}

export async function sendSponsorshipManagerEmail({ account, bookingId, rotate = false }) {
	account = await currentSponsorshipAccount(account, { change: true });
	let booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (!booking.verifiedAt) throw actionError("conflict", "The sponsor hasn't confirmed this request yet");
	if (await isRateLimited({ name: "sponsor-manager-email", key: limitKey(`${account._id}:${booking.email}`), limit: 3, window: "1 h" })) throw actionError("rate_limited", "Wait before requesting another sponsorship management email");
	if (rotate) {
		booking = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id }), { $inc: { managerVersion: 1, revision: 1 } }, { new: true }).lean();
		if (!booking) throw missing();
	}
	const newsletter = await Newsletter.findOne(scoped(account, { _id: booking.newsletterId })).lean();
	if (!newsletter) throw missing();
	const { sendTransactionalEmail } = await import("@/lib/sending");
	const result = await sendTransactionalEmail({ accountId: account._id, newsletterId: newsletter._id, to: booking.email, ...getSponsorshipEmailCopy(newsletter, booking, "manager", getSponsorshipManagerLink(booking)) });
	return { sent: result.sent === true };
}

export async function requestSponsorshipManagerEmail({ newsletterId, bookingId, email }) {
	const key = limitKey(`${newsletterId}:${String(email ?? "").trim().toLowerCase()}`);
	if (await isRateLimited({ name: "sponsor-manager-recovery", key, limit: 3, window: "1 h" })) return { requested: true };
	if (!isObjectIdString(String(newsletterId)) || !isObjectIdString(String(bookingId))) return { requested: true };
	const newsletter = await Newsletter.findOne({ _id: newsletterId }).setOptions({ crossAccount: true }).lean();
	if (!newsletter) return { requested: true };
	const booking = await SponsorshipBooking.findOne(scoped(newsletter.accountId, { _id: bookingId, newsletterId, email: normalizeEmail(email ?? ""), verifiedAt: { $ne: null } })).lean();
	if (booking) {
		try { await sendSponsorshipManagerEmail({ account: newsletter.accountId, bookingId: booking._id }); }
		catch (error) { if (!["not_found", "conflict", "rate_limited"].includes(error.code)) throw error; }
	}
	return { requested: true };
}

export async function updateSponsorshipCreative({ account, bookingId, input, managerVersion }) {
	account = await currentSponsorshipAccount(account, { change: true });
	const { creative, hash, problem } = checkSponsorCreative(input);
	if (problem) throw actionError("validation_failed", problem);
	for (let attempt = 0; attempt < 8; attempt++) {
		const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
		if (!booking.verifiedAt || booking.status === "canceled") throw actionError("conflict", "This sponsorship can't be edited");
		if (managerVersion !== undefined && managerVersion !== booking.managerVersion) throw missing();
		if (booking.campaignId) throw actionError("conflict", "Ask the creator to detach the draft placement before changing its creative");
		if (creative.assetId) {
			const asset = await SponsorshipAsset.findOne(scoped(account, { _id: creative.assetId, newsletterId: booking.newsletterId, bookingId: booking._id })).lean();
			if (asset?.status !== "ready" || !asset.publicationConsentAt) throw actionError("validation_failed", "Choose this booking's uploaded image with publication consent");
		}
		if (hash === booking.creativeHash) return booking;
		const updated = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, ...revisionGuard(booking), ...(managerVersion !== undefined && { managerVersion }) }), { $set: { creative, creativeHash: hash }, $unset: { approvedCreativeHash: 1, approvedAt: 1, approvedBy: 1 }, $inc: { revision: 1 } }, { new: true }).lean();
		if (updated) return updated;
	}
	throw actionError("conflict", "This creative changed. Refresh and try again.");
}

export async function approveSponsorshipCreative({ account, bookingId, expectedHash, actorId }) {
	account = await currentSponsorshipAccount(account, { change: true });
	if (!actorId || String(actorId) !== String(account.ownerId)) throw actionError("forbidden", "Only the account owner can approve sponsor creative");
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	const checked = checkSponsorCreative(booking.creative);
	if (!booking.verifiedAt || booking.status === "canceled" || !expectedHash || checked.problem || checked.hash !== expectedHash || booking.creativeHash !== expectedHash) throw actionError("conflict", "The creative changed. Read its current version before approving.");
	const asset = checked.creative.assetId ? await SponsorshipAsset.findOne(scoped(account, { _id: checked.creative.assetId, newsletterId: booking.newsletterId, bookingId: booking._id })).lean() : null;
	if (checked.creative.assetId && (asset?.status !== "ready" || !asset.publicationConsentAt)) throw actionError("conflict", "This image hasn't been approved for public use by its uploader");
	const saved = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, ...revisionGuard(booking), creativeHash: expectedHash }), { $set: { approvedCreativeHash: expectedHash, approvedAt: new Date(), approvedBy: String(actorId) }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!saved) throw actionError("conflict", "The creative changed before approval. Review it again.");
	if (asset && !asset.publicAt) await SponsorshipAsset.updateOne(scoped(account, { _id: asset._id, bookingId: booking._id, publicationConsentAt: asset.publicationConsentAt, status: "ready", publicAt: null }), { $set: { publicAt: new Date(), publicBy: String(actorId) } });
	return saved;
}
