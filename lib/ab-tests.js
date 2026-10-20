import "server-only";
import { revalidatePath } from "next/cache";
import { AB_TEST, VARIANT_LABELS, pickWinner } from "@/lib/ab-test-rules";
import { sendAlert } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { publishAbTestPick, sendToMoreContacts } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";

const MINUTE_MS = 60_000;
// Too early by less than this, the pick runs instead of waiting again.
const START_EARLY_MS = 60_000;

function recheckAt(minutes = AB_TEST.recheckMinutes) {
	return new Date(Date.now() + minutes * MINUTE_MS);
}

// Runs when QStash delivers the pick, and again on any retry: the winner is picked once (the testing -> picked claim),
// and the rest goes out once (restSentAt), through send_campaign_to_more's own step. A test slice still going out
// waits; a paused one leaves the pick to its resume (lib/sending.js queueCampaign).
export async function runAbTestPick({ accountId, campaignId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId))) return { skipped: "invalid job" };
	await connectDb();
	const campaign = await Campaign.findOne({ accountId, _id: campaignId }).select("accountId status subject stats abTest").lean();
	const abTest = campaign?.abTest;
	if (!abTest?.status || abTest.restSentAt) return { skipped: "no test waiting" };
	if (campaign.status === "paused") return { skipped: "campaign is paused" };
	if (campaign.status !== "sent") {
		await publishAbTestPick(campaign, recheckAt());
		return { waiting: true };
	}
	if (abTest.status === "testing" && abTest.pickAt && new Date(abTest.pickAt).getTime() - Date.now() > START_EARLY_MS) {
		await publishAbTestPick(campaign, new Date(abTest.pickAt));
		return { waiting: true };
	}

	let winner = abTest.winner;
	if (abTest.status === "testing") {
		winner = pickWinner(abTest.variants, abTest.metric);
		await Campaign.updateOne(
			{ accountId: campaign.accountId, _id: campaign._id, "abTest.status": "testing" },
			{ $set: { "abTest.status": "picked", "abTest.winner": winner, "abTest.pickedAt": new Date() } }
		);
		const picked = await Campaign.findOne({ accountId: campaign.accountId, _id: campaign._id }).select("abTest.winner").lean();
		winner = picked.abTest.winner;
	}
	return sendRest(campaign, winner);
}

// The rest of the audience, within the send's own limit, gets the winner. Nobody left is a finished test too.
async function sendRest(campaign, winner) {
	const { accountId, _id: campaignId, abTest } = campaign;
	const sentSoFar = campaign.stats?.recipients ?? 0;
	const additional = abTest.audienceLimit ? abTest.audienceLimit - sentSoFar : undefined;
	const finish = (set = {}) =>
		Campaign.updateOne({ accountId, _id: campaignId, "abTest.restSentAt": null }, { $set: { "abTest.restSentAt": new Date(), ...set }, $unset: { "abTest.problem": 1 } });
	if (additional !== undefined && additional <= 0) {
		await finish();
		return { winner, added: 0 };
	}
	try {
		const { added } = await sendToMoreContacts({ accountId, campaignId: String(campaignId), additional });
		await finish();
		revalidatePath(`/campaigns/${campaignId}`);
		return { winner, added };
	} catch (error) {
		if (error.code === "no_recipients") {
			await finish();
			return { winner, added: 0 };
		}
		// Another step going out: try again once it has.
		if (error.code === "conflict") {
			await publishAbTestPick(campaign, recheckAt());
			return { winner, waiting: true };
		}
		await Campaign.updateOne({ accountId, _id: campaignId }, { $set: { "abTest.problem": String(error.message).slice(0, 300) } });
		await sendAlert({
			accountId,
			key: `ab-test-${campaignId}`,
			title: "Subject line test: the winner didn't go out",
			detail: `Subject ${VARIANT_LABELS[winner]} won "${campaign.subject || "Untitled"}", but sending it to the rest failed: ${error.message.replace(/\.$/, "")}. Send it to them from the campaign's page once that's fixed.`,
			path: `/campaigns/${campaignId}`,
			cooldownMinutes: 1,
		});
		return { winner, failed: error.message, ...(error.code && { code: error.code }) };
	}
}
