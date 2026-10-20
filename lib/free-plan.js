import { ERROR_CODES } from "./account-state.js";
import { FREE_WATCH, isCloud } from "./config.js";
import { formatNumber } from "./format.js";
import { FREE_GUARDS, getPlan, isOnFreeTier, isPaidStatus } from "./plans.js";

const HOUR_MS = 60 * 60 * 1000;

// The small link under the footer of a free account's emails and on its website. Free requires it; a paid plan shows it
// only when the account turned it on (account.sentWithLink, off by default). A self-hosted server never shows it.
export function showsSentWithLink(account) {
	if (!isCloud()) return false;
	return isOnFreeTier(account) || account?.sentWithLink === true;
}

// The paid plan an account had until it ended or lapsed, or null: it is on Free now, with everything it made kept.
export function getLapsedPlan(account) {
	if (!isOnFreeTier(account) || !account.subscriptionStatus || isPaidStatus(account.subscriptionStatus)) return null;
	return getPlan(account.plan);
}

// Whether FlockStack has seen enough of the account to lift the cap on its first campaigns: FREE_GUARDS.firstCampaigns.count
// sent campaigns, each at least settleHours old so their complaints and bounces had time to arrive, with complaints and
// bounces under the Free watch level and at least minOpenRate of the emails opened, all of them together.
// campaigns: { stats, sentAt, finishedAt } of the account's sent campaigns.
export function hasProvenSending(campaigns, now = new Date()) {
	const { count, settleHours, minOpenRate } = FREE_GUARDS.firstCampaigns;
	const settled = campaigns.filter((campaign) => {
		const at = new Date(campaign.finishedAt ?? campaign.sentAt ?? 0).getTime();
		return (campaign.stats?.sent ?? 0) > 0 && at <= now.getTime() - settleHours * HOUR_MS;
	});
	if (settled.length < count) return false;
	const total = (key) => settled.reduce((sum, { stats }) => sum + (stats?.[key] ?? 0), 0);
	const sent = total("sent");
	const isUnder = (value, minimum, rate) => value < minimum || value / sent <= rate;
	return (
		isUnder(total("complained"), FREE_WATCH.minComplaints, FREE_WATCH.complaintRate) &&
		isUnder(total("bounced"), FREE_WATCH.minBounces, FREE_WATCH.bounceRate) &&
		total("opened") / sent >= minOpenRate
	);
}

// Until sending is proven, a campaign of a Free account goes to recipients people at most, however many it already sent in
// steps. Refused up front with the numbers, never cut. An account an admin gave bigger limits (limitOverrides) is trusted.
// total: everyone the campaign would have gone to.
export function getFirstCampaignsProblem({ account, campaigns, total, now = new Date() }) {
	if (!isOnFreeTier(account) || account.limitOverrides?.emailsPerMonth !== undefined || account.limitOverrides?.subscribers !== undefined) return null;
	const { count, recipients } = FREE_GUARDS.firstCampaigns;
	if (total <= recipients || hasProvenSending(campaigns, now)) return null;
	return {
		code: ERROR_CODES.planLimitEmails,
		message: `While FlockStack gets to know your sending, a campaign on the Free plan goes to ${formatNumber(recipients)} people at most. This one would go to ${formatNumber(total)}. Send it to ${formatNumber(recipients)} or fewer contacts, or upgrade. The limit lifts once ${count} campaigns have gone out and settled with few complaints and some opens.`,
	};
}
