import "server-only";
import { scoped } from "@/lib/account-scope";
import { getSharedDomain } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { hasConnectedApp } from "@/lib/oauth";
import Account from "@/models/Account";
import ApiKey from "@/models/ApiKey";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Domain from "@/models/Domain";

// A campaign that went out or will: unscheduling one takes it back to draft.
const SENT_STATUSES = ["scheduled", "sending", "paused", "sent"];

// The dashboard's get-started panel, for any account, paying or not, until it's dismissed or finished.
export function isGetStartedOpen(account) {
	return !account.onboarding?.checklistDismissedAt && !account.onboarding?.checklistFinishedAt;
}

// One cheap query per step, all at once. With a shared domain, sending from one's own is optional. Connecting an
// AI agent comes last: a first send doesn't need it. Once every other step is done the list is finished for good: a
// key revoked later doesn't bring it back. The steps are the account's; the draft to open is the open newsletter's.
export async function getGetStartedSteps(account, newsletterId) {
	await connectDb();
	const [campaign, contact, apiKey, isAppConnected, domain, sent, draft] = await Promise.all([
		Campaign.exists(scoped(account, { status: { $ne: "canceled" } })),
		Contact.exists(scoped(account)),
		ApiKey.exists(scoped(account, { level: "full", revokedAt: null })),
		hasConnectedApp(account),
		Domain.exists(scoped(account, { verified: true })),
		Campaign.exists(scoped(account, { status: { $in: SENT_STATUSES } })),
		newsletterId
			? Campaign.findOne(scoped(account, { newsletterId, status: "draft" })).sort({ updatedAt: -1 }).select({ _id: 1 }).lean()
			: null,
	]);
	const steps = [
		{ id: "write", isDone: Boolean(campaign) },
		{ id: "subscribers", isDone: Boolean(contact) },
		{ id: "domain", isDone: Boolean(domain), isOptional: Boolean(getSharedDomain()) },
		{ id: "send", isDone: Boolean(sent) },
		{ id: "agent", isDone: Boolean(apiKey) || isAppConnected },
	];
	const isFinished = steps.every(({ isDone, isOptional }) => isDone || isOptional);
	if (isFinished) {
		await Account.updateOne(
			{ _id: account._id, "onboarding.checklistFinishedAt": null },
			{ $set: { "onboarding.checklistFinishedAt": new Date() } }
		);
	}
	return { steps, draftId: draft ? String(draft._id) : null, isFinished };
}
