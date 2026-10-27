import "server-only";
import { revalidatePath } from "@/lib/runtime-hooks";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { revalidateArchive } from "@/lib/archive-data";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { HOLD_STALE_MS } from "@/lib/send-hold-rules";
import { checkCampaignSend, publishJob, queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";

// A send the dashboard starts waits in the held status until its time, then a job releases it into queueCampaign, the one
// way every send starts. Release and undo are one write each on the same row, "held and not yet claimed" to something else,
// so exactly one of them wins whenever they meet.

// The audience fields a send overwrites, kept in hold.before so undo gives the draft back as it was.
const SEND_FIELDS = ["audience", "audienceLimit", "audienceOrder", "audienceMinTier", "audienceTiers"];
// A job that QStash delivers a moment early runs at the time instead of waiting for another.
const EARLY_MS = 2000;

function fail(code, message) {
	return codedError({ code, message });
}

function pickDefined(campaign) {
	return Object.fromEntries(SEND_FIELDS.filter((field) => campaign[field] !== undefined && campaign[field] !== null).map((field) => [field, campaign[field]]));
}

// What undo writes back: the saved fields, and no value for the ones the draft didn't have.
function toRestore(before = {}) {
	const set = Object.fromEntries(SEND_FIELDS.filter((field) => before[field] !== undefined).map((field) => [field, before[field]]));
	const unset = Object.fromEntries(SEND_FIELDS.filter((field) => before[field] === undefined).map((field) => [field, 1]));
	return { $set: { status: "draft", ...set }, $unset: { hold: 1, ...unset } };
}

export function publishHeldRelease({ accountId, campaignId, sendAfter }) {
	return publishJob({
		url: `${getAppUrl()}/api/jobs/release-held-send`,
		body: { accountId: String(accountId), campaignId: String(campaignId), sendAfter: sendAfter.toISOString() },
		notBefore: Math.ceil(sendAfter.getTime() / 1000),
	});
}

function refresh(campaignId) {
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${campaignId}`);
}

// A draft to be sent in `seconds`: set and unset are the audience changes the send asked for. The plan's limits, the free
// plan's caps and the from address are checked now and again when it's released, so the writer hears of a problem at the
// click, not a minute later.
export async function holdCampaignSend({ account, campaign, seconds, audienceLimit, audience, audienceOrder, set = {}, unset = {} }) {
	if (campaign.status !== "draft") throw fail("conflict", `This campaign is ${campaign.status}`);
	const emails = await checkCampaignSend({ accountId: account._id, campaignId: campaign._id, audienceLimit, audience, audienceOrder });
	const sendAfter = new Date(Date.now() + seconds * 1000);
	const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "draft" }), {
		$set: { ...set, status: "held", hold: { sendAfter, seconds, recipients: emails, before: pickDefined(campaign) } },
		...(Object.keys(unset).length > 0 && { $unset: unset }),
	});
	if (!matchedCount) throw fail("conflict", "The campaign changed, refresh and try again");
	try {
		await publishHeldRelease({ accountId: account._id, campaignId: campaign._id, sendAfter });
	} catch (error) {
		console.error("[send-hold] Holding failed:", error);
		await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "held", "hold.sendAfter": sendAfter }), toRestore(pickDefined(campaign)));
		throw fail("unavailable", `Couldn't start the send: ${error.message}`);
	}
	refresh(campaign._id);
	return { sendAfter, recipients: emails };
}

// Back to a draft as it was. A send that was released already, or is being, can't be taken back: that is "too late", and
// a second tab pressing Undo after the first finds the draft and is told so too.
export async function undoHeldSend({ account, campaign }) {
	if (campaign.status === "held" && !campaign.hold?.claimedAt) {
		const { matchedCount } = await Campaign.updateOne(
			scoped(account, { _id: campaign._id, status: "held", "hold.claimedAt": { $exists: false } }),
			toRestore(campaign.hold?.before)
		);
		if (matchedCount) {
			refresh(campaign._id);
			return { undone: true };
		}
	}
	const current = await Campaign.findOne(scoped(account, { _id: campaign._id })).select({ status: 1 }).lean();
	if (current?.status === "draft") return { undone: false };
	throw fail("conflict", "It already went out, so it can't be undone");
}

// The release: claim the hold, then start the send as any send starts. Throws what the send throws, after giving the draft
// back (a limit passed in the meantime, a domain that stopped being allowed).
export async function releaseCampaign({ accountId, campaignId }) {
	const claimedAt = new Date();
	const { matchedCount } = await Campaign.updateOne(
		{ accountId, _id: campaignId, status: "held", "hold.claimedAt": { $exists: false } },
		{ $set: { "hold.claimedAt": claimedAt } }
	);
	if (!matchedCount) return null;
	try {
		const result = await queueCampaign({ accountId, campaignId: String(campaignId) });
		refresh(campaignId);
		revalidateArchive();
		return result;
	} catch (error) {
		await giveBack({ accountId, campaignId, error });
		throw error;
	}
}

// Only a campaign still held goes back to a draft: one that started and then paused tells its owner on its own.
async function giveBack({ accountId, campaignId, error }) {
	const campaign = await Campaign.findOne({ accountId, _id: campaignId, status: "held" }).select({ hold: 1, subject: 1 }).lean();
	if (!campaign) return;
	const { matchedCount } = await Campaign.updateOne({ accountId, _id: campaignId, status: "held" }, toRestore(campaign.hold?.before));
	if (!matchedCount) return;
	await sendAlert({
		accountId,
		key: `held-send-${campaignId}`,
		title: "Your send didn't start",
		detail: `${String(error.message).replace(/\.$/, "")}. "${campaign.subject || "Untitled"}" is a draft again.`,
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 1,
	});
	refresh(campaignId);
}

// Runs when QStash delivers the job. A job for a hold that was undone, released or made again since does nothing, so undoing
// never needs to cancel it.
export async function runHeldRelease({ accountId, campaignId, sendAfter, now = Date.now() }) {
	const isValid = isObjectIdString(String(accountId)) && isObjectIdString(String(campaignId)) && typeof sendAfter === "string";
	if (!isValid) return { skipped: "invalid job" };

	await connectDb();
	const campaign = await Campaign.findOne({ accountId, _id: campaignId }).select({ status: 1, hold: 1 }).lean();
	if (campaign?.status !== "held" || campaign.hold?.sendAfter?.toISOString() !== sendAfter) return { skipped: "not held for this time anymore" };
	if (campaign.hold.sendAfter.getTime() - now > EARLY_MS) {
		await publishHeldRelease({ accountId, campaignId, sendAfter: campaign.hold.sendAfter });
		return { waiting: true };
	}
	try {
		const result = await releaseCampaign({ accountId, campaignId });
		return result ? { started: true, ...result } : { skipped: "undone or already released" };
	} catch (error) {
		return { failed: error.message, ...(error.code && { code: error.code }) };
	}
}

// The hourly sweep: a hold whose job never ran (QStash refused it, a Worker died halfway) is released a few minutes late
// rather than left for good. A claim older than that belongs to a release that died, so it is taken again; the send itself
// skips the contacts it already queued.
export async function sweepHeldSends({ now = new Date(), limit = 50 } = {}) {
	await connectDb();
	const cutoff = new Date(now.getTime() - HOLD_STALE_MS);
	const stale = await Campaign.find({ status: "held", "hold.sendAfter": { $lte: cutoff } })
		.setOptions({ crossAccount: true })
		.select({ accountId: 1, hold: 1 })
		.limit(limit)
		.lean();
	const result = { released: 0, reverted: 0 };
	for (const campaign of stale) {
		const { accountId, _id: campaignId } = campaign;
		if (campaign.hold?.claimedAt) {
			if (campaign.hold.claimedAt > cutoff) continue;
			await Campaign.updateOne({ accountId, _id: campaignId, status: "held", "hold.claimedAt": campaign.hold.claimedAt }, { $unset: { "hold.claimedAt": 1 } });
		}
		try {
			if (await releaseCampaign({ accountId, campaignId })) result.released++;
		} catch (error) {
			console.error(`[send-hold] Releasing held campaign ${campaignId} failed:`, error.message);
			result.reverted++;
		}
	}
	return result;
}
