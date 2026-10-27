"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { toActionError } from "@/lib/actions/errors";
import { readReaderBillingAccess, limitReaderBilling } from "@/lib/reader-billing-access";
import { cancelReaderSubscription } from "@/lib/reader-cancellation";
import { cancelScheduledReaderPause, resumeReaderSubscription, scheduleReaderPause } from "@/lib/reader-pause";
import { readerRetentionOutput } from "@/lib/reader-retention-output";
import { readCurrentReaderBilling } from "@/lib/reader-retention-store";
import { acceptReaderSaveOffer } from "@/lib/reader-save-offer";
import { getClientIp } from "@/lib/rate-limit";
import { openSubscriberPortal } from "@/lib/shop";

export async function changeReaderBilling(_previous, form) {
	let portal;
	try {
		const token = String(form.get("token") ?? ""), operation = String(form.get("operation"));
		const context = await readReaderBillingAccess(token), ip = getClientIp(await headers());
		await limitReaderBilling(context, ip, true);
		const input = { account: context.account, newsletterId: context.newsletterId, contactId: context.contactId, externalId: String(form.get("externalId")) };
		let result;
		switch (operation) {
			case "refresh": return { output: await readerRetentionOutput(await readCurrentReaderBilling(input)) };
			case "portal": { const response = await openSubscriberPortal({ token, ip }); if (response.error) return { error: response.error }; portal = response.url; break; }
			case "pause": result = await scheduleReaderPause({ ...input, months: Number(form.get("months")) }); break;
			case "unpause": result = await cancelScheduledReaderPause(input); break;
			case "resume": result = await resumeReaderSubscription({ ...input, confirmBilling: form.get("confirm") === "on" }); break;
			case "save": result = await acceptReaderSaveOffer({ ...input, offerId: String(form.get("offerId")), expectedHash: String(form.get("expectedHash")), confirm: form.get("confirm") === "on" }); break;
			case "cancel": result = await cancelReaderSubscription({ ...input, confirm: form.get("confirm") === "on", response: { reason: String(form.get("reason") ?? "") || null, comment: String(form.get("comment") ?? ""), shareWithCreator: form.get("shareWithCreator") === "on" } }); break;
			default: return { error: "Unknown billing action" };
		}
		if (result) return { output: await readerRetentionOutput(result.context, result.record) };
	} catch (error) { return { error: toActionError(error).message }; }
	if (portal) redirect(portal);
	return { error: "The billing page is temporarily unavailable" };
}
