"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { readSponsorshipContext, requestSponsorship, requestSponsorshipManagerEmail, updateSponsorshipCreative, verifySponsorshipRequest } from "@/lib/sponsorship-bookings";
import { cancelSponsorship } from "@/lib/sponsorship-cancellation";
import { readSponsorshipAsset, removeSponsorshipAsset } from "@/lib/sponsorship-assets";
import { refreshSponsorshipInvoice } from "@/lib/sponsorship-billing";
import { toActionError } from "@/lib/actions/errors";

export async function makeSponsorRequest(_previous, form) {
	try {
		const newsletter = await findOpenNewsletter({ slug: String(form.get("newsletter") ?? "").slice(0, 100) });
		if (!newsletter) return { error: "This newsletter isn't taking sponsorship requests" };
		const result = await requestSponsorship({ account: newsletter.accountId, newsletter, input: { slotId: String(form.get("slotId")), email: String(form.get("email")), brandName: String(form.get("brandName")), externalId: String(form.get("externalId")) } });
		return result.verificationSent || result.alreadyRequested ? { ok: true, message: "Check the sponsor inbox to confirm this request. It hasn't reserved a date or subscribed you." } : { error: "The verification email couldn't be sent. Contact the creator before retrying." };
	} catch (error) { return { error: toActionError(error).message }; }
}
export async function confirmSponsorRequest(_previous, form) {
	let result;
	try { result = await verifySponsorshipRequest(String(form.get("token") ?? "")); }
	catch (error) { return { error: toActionError(error).message }; }
	redirect(result.managerUrl);
}
export async function recoverSponsorLink(_previous, form) {
	try { await requestSponsorshipManagerEmail({ newsletterId: String(form.get("newsletterId")), bookingId: String(form.get("bookingId")), email: String(form.get("email")) }); }
	catch { /* Recovery gives the same answer whether the identity exists or the email cannot be sent. */ }
	return { ok: true, message: "If these details match a verified request, a private management link will be emailed to the sponsor." };
}
export async function manageSponsorship(_previous, form) {
	try {
		const { account, booking, reference } = await readSponsorshipContext(String(form.get("token") ?? ""));
		const operation = String(form.get("operation"));
		const target = { account, bookingId: booking._id, managerVersion: reference.version };
		if (operation === "creative") await updateSponsorshipCreative({ ...target, input: { headline: String(form.get("headline")), body: String(form.get("body")), callToAction: String(form.get("callToAction")), url: String(form.get("url")), assetId: String(form.get("assetId") ?? "") || null } });
		else if (operation === "withdraw") await cancelSponsorship(target);
		else if (operation === "remove") await removeSponsorshipAsset({ ...target, assetId: String(form.get("assetId")) });
		else if (operation === "preview") { const asset = await readSponsorshipAsset({ ...target, assetId: String(form.get("assetId")), includeContent: true }); return { dataUrl: asset.dataUrl }; }
		else if (operation === "refresh") { const current = await refreshSponsorshipInvoice(target); revalidatePath("/reader/sponsorships/manage"); return { ok: true, url: current.invoice?.hostedUrl ?? null }; }
		else return { error: "Choose a sponsorship action" };
		revalidatePath("/reader/sponsorships/manage"); return { ok: true };
	} catch (error) { return { error: toActionError(error).message }; }
}
