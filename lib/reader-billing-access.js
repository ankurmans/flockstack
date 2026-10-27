import "server-only";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { connectDb } from "@/lib/db";
import { readPortalToken } from "@/lib/portal-link";
import { isRateLimited } from "@/lib/rate-limit";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// The existing email capability authorizes billing even after an email unsubscribe. It never signs a reader in.
export async function readReaderBillingAccess(token) {
	const reference = readPortalToken(token);
	if (!reference) throw actionError("not_found", "This billing link has expired or is no longer valid. Use a more recent email.");
	await connectDb();
	const contact = await Contact.findOne({ _id: reference.contactId, newsletterId: reference.newsletterId }).setOptions({ crossAccount: true }).lean();
	const account = contact && await Account.findById(contact.accountId).lean();
	const newsletter = account && await Newsletter.findOne(scoped(account, { _id: contact.newsletterId })).lean();
	if (!contact?.stripeCustomerId || !newsletter || isDeletionPending(account)) throw actionError("not_found", "This reader's billing is no longer available");
	return { account, newsletter, contact, contactId: contact._id, newsletterId: newsletter._id };
}

export async function limitReaderBilling(context, ip, mutation = false) {
	const name = mutation ? "reader-billing-change" : "reader-billing-read";
	if (await isRateLimited({ name, limit: mutation ? 30 : 60, window: "10 m", key: String(context.contactId) }) || await isRateLimited({ name: `${name}-ip`, limit: mutation ? 90 : 180, window: "10 m", key: ip })) throw actionError("rate_limited", "Too many billing requests. Try again in a few minutes.");
}

export function hasReaderBillingFeatures(newsletter) {
	const settings = newsletter.readerRetention;
	return Boolean(settings?.pauseEnabled || settings?.surveyEnabled || settings?.saveOfferId);
}
