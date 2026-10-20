import { scoped } from "@/lib/account-scope";
import Automation from "@/models/Automation";
import AutomationEnrollment from "@/models/AutomationEnrollment";
import Contact from "@/models/Contact";

// What starts a contact in an automation, and what takes it out, with no way to send an email from here: signups,
// tags and unsubscribes call these, and lib/automations.js runs the steps.

const EXIT_BY_STATUS = { unsubscribed: "unsubscribed", bounced: "bounced", complained: "complained", dormant: "dormant" };

export function getExitReason(contact, isSuppressed = false) {
	if (!contact) return "deleted";
	if (contact.status === "active") return isSuppressed ? "suppressed" : null;
	return EXIT_BY_STATUS[contact.status] ?? "inactive";
}

// A contact enters an automation once per cycle, however many things try to start it. Returns whether this call did.
// trigger: what started it when that isn't the automation's own trigger (another automation moving the contact).
export async function enrollContact({ automation, contact, cycle = "once", now = new Date(), trigger = automation.trigger.type }) {
	if (contact.status !== "active") return false;
	const [first] = automation.steps ?? [];
	try {
		await AutomationEnrollment.create({
			accountId: automation.accountId,
			automationId: automation._id,
			newsletterId: automation.newsletterId,
			contactId: contact._id,
			cycle,
			trigger,
			stepIndex: 0,
			...(first && { stepId: first.id }),
			nextRunAt: now,
			enrolledAt: now,
		});
		return true;
	} catch (error) {
		if (error?.code === 11000) return false;
		throw error;
	}
}

function findActiveAutomations(contact, type) {
	return Automation.find({ accountId: contact.accountId, newsletterId: contact.newsletterId, status: "active" })
		.lean()
		.then((automations) => automations.filter((automation) => automation.trigger?.type === type));
}

// The active automations of the contact's newsletter that start on this event and whose trigger accepts it, started for
// the contact. Never breaks the call that reports the event: a signup, a payment and a click matter more.
async function enrollOnEvent(type, contact, { accepts = () => true, cycle = "once", now = new Date() } = {}) {
	try {
		for (const automation of await findActiveAutomations(contact, type)) {
			if (accepts(automation.trigger)) await enrollContact({ automation, contact, cycle, now });
		}
	} catch (error) {
		console.error(`[automations] Could not start the automations for contact ${contact._id}:`, error.message);
	}
}

// A contact who just joined: new and active, back from unsubscribing, or confirmed. For the automations that start on
// subscribing, narrowed by the tag and source they name. Never breaks the signup that called it.
export function enrollOnSubscribed(contact) {
	return enrollOnEvent("subscribed", contact, {
		accepts: ({ tag, source }) => (!tag || (contact.tags ?? []).includes(tag)) && (!source || contact.source === source),
	});
}

// Tags a contact just got, for the automations that start on one of them. Never breaks the call that added them.
export async function enrollOnTagsAdded(contact, tags) {
	if (tags.length === 0) return;
	await enrollOnEvent("tag_added", contact, { accepts: (trigger) => tags.includes(trigger.tag) });
}

export async function enrollOnTagsRemoved(contact, tags) {
	if (tags.length === 0) return;
	await enrollOnEvent("tag_removed", contact, { accepts: (trigger) => tags.includes(trigger.tag) });
}

// Custom fields that got a new value or lost theirs, by key.
export async function enrollOnFieldsChanged(contact, keys) {
	if (keys.length === 0) return;
	await enrollOnEvent("field_changed", contact, { accepts: (trigger) => keys.includes(trigger.field) });
}

// A reader started paying (upgraded) or stopped (downgraded). Each change is its own: a reader who upgrades again starts
// the automation again.
export function enrollOnTierChange(contact, type, now = new Date()) {
	return enrollOnEvent(type, contact, { cycle: `${type[0]}${now.getTime()}`, now });
}

// A reader paid for a product, if they are a contact of the product's newsletter. Each purchase is its own.
export async function enrollOnProductBought(order) {
	try {
		const contact = await Contact.findOne({ accountId: order.accountId, newsletterId: order.newsletterId, email: order.buyerEmail }).lean();
		if (!contact) return;
		await enrollOnEvent("product_bought", contact, {
			accepts: (trigger) => !trigger.product || trigger.product === String(order.productId),
			cycle: String(order._id),
		});
	} catch (error) {
		console.error(`[automations] Could not start the automations for order ${order._id}:`, error.message);
	}
}

// The referrer, with the credits they have now: each credit is its own, and a trigger can wait for a number of them.
export function enrollOnReferralCredited(referrer, count) {
	return enrollOnEvent("referral_credited", referrer, {
		accepts: (trigger) => !trigger.referrals || trigger.referrals === count,
		cycle: `r${count}`,
	});
}

// The address a trigger names and a link's compare equal when they only differ by a trailing slash, a fragment or the
// case of the host.
export function normalizeLinkUrl(value) {
	try {
		const url = new URL(String(value).trim());
		url.hash = "";
		return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
	} catch {
		return String(value).trim();
	}
}

// A reader's first click on a link in an issue. link: its place in the issue; url: its address.
export function enrollOnLinkClicked(contact, { campaignId, url }) {
	const clicked = normalizeLinkUrl(url);
	return enrollOnEvent("link_clicked", contact, {
		accepts: (trigger) => normalizeLinkUrl(trigger.url) === clicked && (!trigger.campaign || trigger.campaign === String(campaignId)),
	});
}

// Takes contacts out of every automation they are in, now that they unsubscribed, bounced or complained (the job
// checks again before each step, so this only makes the counts follow at once).
export async function exitEnrollments({ accountId, contactIds, reason }) {
	if (contactIds.length === 0) return 0;
	const { modifiedCount } = await AutomationEnrollment.updateMany(
		scoped(accountId, { contactId: { $in: contactIds }, status: "active" }),
		{ $set: { status: "exited", exitReason: reason, exitedAt: new Date() }, $unset: { nextRunAt: 1, lockedUntil: 1 } }
	);
	return modifiedCount;
}

// The same by email address, for events from the email provider, which name the address.
export async function exitEnrollmentsForEmails({ accountId, emails, reason }) {
	if (emails.length === 0) return 0;
	const contacts = await Contact.find(scoped(accountId, { email: { $in: emails } })).select({ _id: 1 }).lean();
	return exitEnrollments({ accountId, contactIds: contacts.map(({ _id }) => _id), reason });
}
