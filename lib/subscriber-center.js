import { activeMailingLists } from "@/lib/mailing-lists";
import "server-only";
import { scoped } from "@/lib/account-scope";
import { getShopPayments } from "@/lib/archive-data";
import { getArchiveUrls, getLinkBaseUrl } from "@/lib/archive-hosts";
import { listCustomFields, parseFieldValue } from "@/lib/custom-fields";
import { getPortalUrl } from "@/lib/portal-link";
import { getReaderReferralStatus } from "@/lib/referrals";
import { createSubscriberToken } from "@/lib/subscriber-links";
import { getAccessEnd, isGrantDriving } from "@/lib/grants";
import { describePledgeAmount, getPledgeCancelUrl, isPledgeOpen } from "@/lib/pledges";
import { findTier, getContactTierId, getNewsletterTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { createUnsubscribeToken } from "@/lib/unsubscribe";
import { isCurrentSupporter } from "@/lib/supporter-badges";
import Contact from "@/models/Contact";
import Pledge from "@/models/Pledge";

// The Subscriber Center: one page for a signed-in reader (lib/reader-session.js) with their profile, the preference center,
// their subscription and billing, their referral link and the way out. It reads and writes only the reader's own contact.
// A contact has no name of its own: a newsletter that asks for one has a text custom field called first_name or name.
const NAME_KEYS = ["first_name", "name"];
const MAX_NAME_LENGTH = 100;

async function findNameField(newsletter) {
	const fields = await listCustomFields({ _id: newsletter.accountId }, newsletter._id);
	return fields.find((field) => NAME_KEYS.includes(field.key) && field.type === "text") ?? null;
}

// The page's data. contact: the active subscriber behind the session.
export async function getSubscriberCenter({ newsletter, contact }) {
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const [fields, nameField, payments] = await Promise.all([listCustomFields({ _id: newsletter.accountId }, newsletter._id), findNameField(newsletter), getShopPayments(newsletter)]);
	const isPaid = isPaidContact(contact);
	const urls = getArchiveUrls(newsletter);
	const referral = await getReaderReferralStatus({ newsletter, contact });
	const canUpgrade = (Boolean(newsletter.paidTier?.enabled) || isPledgeOpen(newsletter)) && payments.ready;
	const tiers = getNewsletterTiers(newsletter);
	const pledge = isPaid ? null : await findOpenPledge({ newsletter, contact });
	return {
		email: contact.email,
		supporterBadge: { enabled: contact.community?.supporterBadge === true, eligible: isCurrentSupporter(newsletter, contact) },
		subscribedAt: contact.confirmedAt ?? contact.subscribedAt ?? null,
		name: nameField ? { key: nameField.key, label: nameField.label, value: String(contact.fields?.[nameField.key] ?? "") } : null,
		subscription: {
			isPaid,
			// The tier they hold, and how they are paid: stripe (a subscription or a lifetime payment), comp or gift.
			tier: isPaid ? { id: getContactTierId(contact), name: findTier(tiers, getContactTierId(contact))?.name ?? null } : null,
			access: isPaid ? (isGrantDriving(contact) ? contact.grant.kind : "stripe") : null,
			interval: isPaid ? (contact.paidInterval ?? null) : null,
			paidUntil: isPaid ? (getAccessEnd(contact) ?? null) : null,
			status: contact.subscriptionStatus ?? null,
			// Stripe's own page, on the creator's account: card, invoices and cancelling. Only for someone who has been billed.
			manageUrl: contact.stripeCustomerId && (isPaid || contact.stripeSubscriptionId || contact.lifetimePaymentIntentId) ? getPortalUrl(reference, getLinkBaseUrl(newsletter)) : null,
			upgradeUrl: !isPaid && canUpgrade ? urls.subscribe : null,
		},
		// A pledge they made: nothing is charged until the writer starts charging, and they can cancel it here.
		pledge,
		preferences: {
			lists: activeMailingLists(newsletter),
			listIds: contact.listIds ?? [],
			token: createSubscriberToken("preferences", reference),
			fields: fields.filter((field) => field.readerEditable).map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) })),
		},
		referral: referral.isActive ? { count: referral.count, link: referral.link, next: referral.next, pageUrl: referral.pageUrl } : null,
		unsubscribeUrl: `/unsubscribe?token=${createUnsubscribeToken(reference)}`,
	};
}

async function findOpenPledge({ newsletter, contact }) {
	const pledge = await Pledge.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, email: contact.email, status: { $in: ["active", "notifying", "scheduled"] } })
		.sort({ createdAt: -1 })
		.lean();
	if (!pledge) return null;
	return {
		amount: describePledgeAmount(pledge, newsletter),
		tierName: findTier(getNewsletterTiers(newsletter), pledge.tierId)?.name ?? null,
		chargeAt: pledge.status === "scheduled" ? (pledge.chargeAt ?? null) : null,
		cancelUrl: getPledgeCancelUrl(pledge, newsletter),
	};
}

// { ok: true } or { problem }. Only the newsletter's name field is the reader's to set here.
export async function saveProfileName({ newsletter, contact, name }) {
	const field = await findNameField(newsletter);
	if (!field) return { problem: "This newsletter doesn't ask for a name." };
	const text = String(name ?? "").trim();
	if (text.length > MAX_NAME_LENGTH) return { problem: `Use ${MAX_NAME_LENGTH} characters or fewer for your name.` };
	const parsed = parseFieldValue(field.type, text, field);
	if (parsed.problem) return { problem: `${field.label} ${parsed.problem}` };
	const update = parsed.value === null ? { $unset: { [`fields.${field.key}`]: 1 } } : { $set: { [`fields.${field.key}`]: parsed.value } };
	await Contact.updateOne(scoped({ _id: newsletter.accountId }, { _id: contact._id, newsletterId: newsletter._id }), update);
	return { ok: true };
}
