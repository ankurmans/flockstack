import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getOfferProblem } from "@/lib/offer-rules";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import Offer from "@/models/Offer";

export function readerRetentionSettingsOutput(newsletter) {
	return { newsletterId: String(newsletter._id), pauseEnabled: newsletter.readerRetention?.pauseEnabled === true, surveyEnabled: newsletter.readerRetention?.surveyEnabled === true, saveOfferId: newsletter.readerRetention?.saveOfferId ? String(newsletter.readerRetention.saveOfferId) : null, newSubscriptionsFlexible: newsletter.readerRetention?.pauseEnabled === true, pauseMonths: [1, 3, 6] };
}

export async function saveReaderRetentionSettings({ account, newsletter, input }) {
	const old = readerRetentionSettingsOutput(newsletter);
	const pauseEnabled = input.pauseEnabled ?? old.pauseEnabled, surveyEnabled = input.surveyEnabled ?? old.surveyEnabled;
	const saveOfferId = input.saveOfferId === undefined ? old.saveOfferId : input.saveOfferId;
	if (pauseEnabled || saveOfferId) assertPaymentsReady(account);
	if (pauseEnabled && !old.pauseEnabled && input.confirmFlexibleBilling !== true) throw actionError("validation_failed", "Confirm that new recurring purchases use flexible Stripe billing. Existing subscriptions will not be migrated.");
	if (saveOfferId) {
		const offer = isObjectIdString(saveOfferId) ? await Offer.findOne(scoped(account, { _id: saveOfferId, newsletterId: newsletter._id })).lean() : null;
		if (!offer || !["percent", "amount"].includes(offer.type) || !offer.stripeCouponId || offer.trialDays > 0 || offer.trialAmountCents > 0 || getOfferProblem(offer, { currency: newsletter.paidTier?.currency ?? "usd" })) throw actionError("validation_failed", "Select this newsletter's active existing discount offer, with no trial and a prepared Stripe coupon");
	}
	const saved = await Newsletter.findOneAndUpdate(scoped(account, { _id: newsletter._id }), { $set: { "readerRetention.pauseEnabled": pauseEnabled, "readerRetention.surveyEnabled": surveyEnabled, ...(saveOfferId && { "readerRetention.saveOfferId": saveOfferId }) }, ...(!saveOfferId && { $unset: { "readerRetention.saveOfferId": 1 } }) }, { new: true }).lean();
	if (!saved) throw actionError("not_found", "Newsletter not found");
	return readerRetentionSettingsOutput(saved);
}
