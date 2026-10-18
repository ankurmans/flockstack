import "server-only";
import { areWelcomeEmailsPaused, hasActiveSubscription, isBlocked, isDeletionPending } from "@/lib/account-state";
import { scoped } from "@/lib/account-scope";
import { connectDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { getAccountPlan, isOnFreePlan } from "@/lib/plans";
import { getRegion } from "@/lib/region";
import Domain from "@/models/Domain";

// The few facts about a signed-in person's account the support assistant may know: its plan, region, whether its own
// sending domains are verified, and whether it is blocked and why. Read-only, and never an email address, a subscriber,
// a contact, an issue's content or a key: the prompt (lib/marketing/support-prompt.js) gets only this object.
export async function getSupportContext(account) {
	if (!account?._id) return null;
	await connectDb();
	const domains = await Domain.find(scoped(account)).select({ verified: 1 }).lean();
	return {
		region: getRegion(),
		plan: describePlan(account),
		domains: { total: domains.length, verified: domains.filter(({ verified }) => verified).length },
		blocked: isBlocked(account),
		blockReason: isBlocked(account) ? String(account.pauseReason ?? "").trim().slice(0, 300) || null : null,
		welcomePaused: areWelcomeEmailsPaused(account),
		deletionPending: isDeletionPending(account),
	};
}

const STATUS_NOTES = { past_due: "the last payment failed and is being retried", trialing: "in its trial" };

function describePlan(account) {
	const plan = getAccountPlan(account);
	if (isOnFreePlan(account)) {
		const until = account.comp?.until ? ` until ${formatDate(account.comp.until)}` : "";
		return `${plan.name}, a free plan from FlockStack${until}`;
	}
	if (!hasActiveSubscription(account) || !plan) return "none, so the account can't send until it picks one on the billing page";
	const note = STATUS_NOTES[account.subscriptionStatus];
	return `${plan.name}, billed ${account.interval === "year" ? "yearly" : "monthly"}${note ? `, ${note}` : ""}`;
}
