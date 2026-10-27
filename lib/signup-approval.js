import "server-only";
import { scoped } from "@/lib/account-scope";
import { enrollOnSubscribed } from "@/lib/automation-triggers";
import { withEngagement } from "@/lib/cleanup";
import { isSendingEnabled } from "@/lib/config";
import { removeContact } from "@/lib/contacts";
import { emitSubscriberEvent } from "@/lib/webhooks";
import Contact from "@/models/Contact";

// A newsletter that approves new subscribers (Newsletter.signupApproval) keeps a signup as a `held` contact, after its
// confirmation where one is asked, until the owner lets it in. A held contact is sent nothing, counts toward no limit as active
// and cannot sign in to a private website. Anyone added by hand or who pays has the owner's word already and is never held.
export const APPROVAL_BATCH = 100;

async function findHeld(account, newsletter, { contactIds, all }) {
	const filter = scoped(account, { newsletterId: newsletter._id, status: "held", ...(!all && { _id: { $in: contactIds } }) });
	return Contact.find(filter).sort({ subscribedAt: 1, _id: 1 }).limit(APPROVAL_BATCH).lean();
}

// Lets held signups in: they become active like a confirmed subscriber (automations that start on a subscription start, the
// welcome email goes out, a referral or a recommendation that brought them is credited) and webhook endpoints hear
// subscriber.approved. At most APPROVAL_BATCH at a time, oldest first; { approved, remaining } tells whether to call again.
export async function approveHeldContacts({ account, newsletter, contactIds = [], all = false }) {
	const held = await findHeld(account, newsletter, { contactIds, all });
	let approved = 0;
	for (const contact of held) {
		const updated = await Contact.findOneAndUpdate(
			scoped(account, { _id: contact._id, newsletterId: newsletter._id, status: "held" }),
			withEngagement({ $set: { status: "active", approvedAt: new Date() } }),
			{ returnDocument: "after" }
		).lean();
		if (!updated) continue;
		approved += 1;
		await afterApproval({ newsletter, contact: updated });
	}
	return { approved, remaining: all ? await Contact.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "held" })) : null };
}

async function afterApproval({ newsletter, contact }) {
	const attempt = (label, work) => Promise.resolve().then(work).catch((error) => console.error(`[approval] ${label} for ${contact._id} failed:`, error.message));
	await attempt("Automations", () => enrollOnSubscribed(contact));
	await attempt("Webhook", () => emitSubscriberEvent("subscriber.approved", contact));
	await attempt("Referral", async () => (await import("@/lib/referrals")).creditReferral({ newsletter, contact }));
	await attempt("Recommendation", async () => (await import("@/lib/recommendations")).countConfirmation({ newsletter, contact }));
	if (isSendingEnabled()) await attempt("Welcome email", async () => (await import("@/lib/sending")).queueWelcomeEmail({ newsletter, contact }));
}

// Turns held signups down by deleting them: nothing about them is kept, and they can ask again. A hold the owner never answers
// stays until someone does.
export async function rejectHeldContacts({ account, newsletter, contactIds = [], all = false }) {
	const held = await findHeld(account, newsletter, { contactIds, all });
	let rejected = 0;
	for (const contact of held) if (await removeContact(account, contact)) rejected += 1;
	return { rejected, remaining: all ? await Contact.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "held" })) : null };
}
