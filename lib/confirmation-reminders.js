import "server-only";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { REMINDER_HOURS } from "@/lib/newsletter-settings";
import { queueConfirmationReminders } from "@/lib/sending";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

const HOUR_MS = 3_600_000;
// Signups older than their reminder's time by more than this get none: turning reminders on doesn't email people who
// signed up long ago.
const LATE_HOURS = 72;
// A run claims this many at most; the next hour's takes the rest, within LATE_HOURS.
const MAX_PER_RUN = 2000;

// Every hour (app/api/cron/hourly): newsletters with confirmed opt-in and reminders on send their one reminder to each
// signup still pending delayHours after signing up. Each contact is claimed (confirmReminderAt) before its email is
// queued, so two runs never remind anyone twice.
export async function sendConfirmationReminders({ now = Date.now() } = {}) {
	if (!isSendingEnabled()) return { skipped: "sending is off" };
	await connectDb();
	const newsletters = await Newsletter.find({ "confirmationReminder.enabled": true, requireConfirmation: true })
		.setOptions({ crossAccount: true })
		.lean();
	let queued = 0;
	for (const newsletter of newsletters) {
		if (queued >= MAX_PER_RUN) break;
		const due = now - (newsletter.confirmationReminder.delayHours ?? REMINDER_HOURS.default) * HOUR_MS;
		const contacts = await Contact.find({
			accountId: newsletter.accountId,
			newsletterId: newsletter._id,
			status: "pending",
			subscribedAt: { $lte: new Date(due), $gte: new Date(due - LATE_HOURS * HOUR_MS) },
			confirmReminderAt: { $exists: false },
		})
			.limit(MAX_PER_RUN - queued)
			.select({ email: 1, status: 1 })
			.lean();
		if (contacts.length === 0) continue;
		const ids = contacts.map(({ _id }) => _id);
		await Contact.updateMany(
			{ accountId: newsletter.accountId, _id: { $in: ids }, confirmReminderAt: { $exists: false } },
			{ $set: { confirmReminderAt: new Date(now) } }
		);
		const claimed = await Contact.find({ accountId: newsletter.accountId, _id: { $in: ids }, confirmReminderAt: new Date(now) }).select({ email: 1, status: 1 }).lean();
		try {
			queued += (await queueConfirmationReminders({ newsletter, contacts: claimed })).queued;
		} catch (error) {
			console.error(`[reminders] ${newsletter.slug}: ${error.message}`);
		}
	}
	return { newsletters: newsletters.length, queued };
}
