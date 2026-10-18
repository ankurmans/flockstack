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
export async function enrollContact({ automation, contact, cycle = "once", now = new Date() }) {
	if (contact.status !== "active") return false;
	const [first] = automation.steps ?? [];
	try {
		await AutomationEnrollment.create({
			accountId: automation.accountId,
			automationId: automation._id,
			newsletterId: automation.newsletterId,
			contactId: contact._id,
			cycle,
			trigger: automation.trigger.type,
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

// A contact who just joined: new and active, back from unsubscribing, or confirmed. For the automations that start on
// subscribing, narrowed by the tag and source they name. Never breaks the signup that called it.
export async function enrollOnSubscribed(contact) {
	try {
		const automations = await findActiveAutomations(contact, "subscribed");
		for (const automation of automations) {
			const { tag, source } = automation.trigger;
			if (tag && !(contact.tags ?? []).includes(tag)) continue;
			if (source && contact.source !== source) continue;
			await enrollContact({ automation, contact });
		}
	} catch (error) {
		console.error(`[automations] Could not start the automations for contact ${contact._id}:`, error.message);
	}
}

// Tags a contact just got, for the automations that start on one of them. Never breaks the call that added them.
export async function enrollOnTagsAdded(contact, tags) {
	if (tags.length === 0) return;
	try {
		const automations = await findActiveAutomations(contact, "tag_added");
		for (const automation of automations) {
			if (tags.includes(automation.trigger.tag)) await enrollContact({ automation, contact });
		}
	} catch (error) {
		console.error(`[automations] Could not start the automations for contact ${contact._id}:`, error.message);
	}
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
