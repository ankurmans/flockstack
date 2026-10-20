import "server-only";
import { findOwnerEmail } from "@/lib/accounts";
import { countRecentSends } from "@/lib/account-health";
import { connectDb } from "@/lib/db";
import { IP_WARMUP, getShareForDay, judgeWarmupStep } from "@/lib/ip-warmup-rules";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import Account from "@/models/Account";
import DedicatedIp from "@/models/DedicatedIp";
import Message from "@/models/Message";

// The hourly job that moves the warm-up of every account with a dedicated IP a day on (lib/ip-warmup-rules.js): the share
// of its email that goes through the IP goes up, unless the day is held because bounces or complaints are above the
// watch level or the account sent too little to warm anything. A day is counted once however often the job runs.

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

async function countEmailsLastDay(accountId, now) {
	return Message.countDocuments({ accountId, sentAt: { $gte: new Date(now.getTime() - DAY_MS) } });
}

async function finish(account) {
	await DedicatedIp.updateOne({ accountId: account._id, state: "warming" }, { $set: { state: "assigned" } });
	console.info(`[ip] The warm-up of account ${account._id}'s dedicated IP is complete`);
	try {
		const to = canSendPlatformEmail() ? await findOwnerEmail(account._id) : null;
		if (to) {
			await sendPlatformEmail({
				to,
				subject: "Your dedicated IP is warmed up",
				text: `The warm-up of your dedicated IP is done. All of your email now goes through it. Keep sending regularly: an IP that goes quiet for weeks loses the reputation it built.`,
			});
		}
	} catch (error) {
		console.error(`[ip] Couldn't email the owner of account ${account._id}:`, error.message);
	}
}

// Returns what it did: { advanced, held, completed }.
export async function advanceIpWarmups({ now = new Date() } = {}) {
	await connectDb();
	const due = new Date(now.getTime() - IP_WARMUP.dayHours * 60 * 60 * 1000);
	const accounts = await Account.find({
		"ses.ipWarmup.startedAt": { $exists: true },
		"ses.ipWarmup.completedAt": { $exists: false },
		"ses.ipWarmup.advancedAt": { $lt: due },
	})
		.select({ ses: 1, status: 1 })
		.limit(BATCH)
		.lean();
	const done = { advanced: 0, held: 0, completed: 0 };
	for (const account of accounts) {
		const warmup = account.ses.ipWarmup;
		try {
			const [counts, emailsLastDay] = await Promise.all([countRecentSends(account._id, now), countEmailsLastDay(account._id, now)]);
			const step = judgeWarmupStep({ warmup, counts, emailsLastDay, isPaused: account.status === "paused", now });
			if (step.action === "wait") continue;
			// The day is counted first and only by the run that wins it, so a second run in the same hour changes nothing.
			const { modifiedCount } = await Account.updateOne(
				{ _id: account._id, "ses.ipWarmup.advancedAt": warmup.advancedAt },
				{ $set: { "ses.ipWarmup.advancedAt": now } }
			);
			if (!modifiedCount) continue;
			if (step.action === "hold") {
				await Account.updateOne(
					{ _id: account._id },
					{ $set: { "ses.ipWarmup.holdReason": step.reason, "ses.ipWarmup.heldAt": now }, $inc: { "ses.ipWarmup.holds": 1 } }
				);
				done.held++;
				continue;
			}
			const day = Math.min(IP_WARMUP.days, (warmup.day ?? 1) + 1);
			const isComplete = day >= IP_WARMUP.days;
			await Account.updateOne(
				{ _id: account._id },
				{
					$set: { "ses.ipWarmup.day": day, "ses.ipWarmup.share": getShareForDay(day), ...(isComplete && { "ses.ipWarmup.completedAt": now }) },
					$unset: { "ses.ipWarmup.holdReason": 1, "ses.ipWarmup.heldAt": 1 },
				}
			);
			done.advanced++;
			if (isComplete) {
				done.completed++;
				await finish(account);
			}
		} catch (error) {
			console.error(`[ip] Couldn't move the warm-up of account ${account._id} on:`, error.message);
		}
	}
	return done;
}
