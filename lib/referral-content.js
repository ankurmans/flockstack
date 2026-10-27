import { formatCount } from "./format.js";
import { getNextReward } from "./referral-rules.js";

// The email that announces a reward a subscriber unlocked. It goes through the ordinary sending path, so it carries the
// unsubscribe link and counts toward the plan like a welcome email.
export function getRewardEmail({ newsletter, reward, count, pageUrl }) {
	const next = getNextReward(newsletter.referral?.rewards ?? [], count);
	const lines = [
		`**You've referred ${formatCount(count, "reader")}. That unlocks: ${reward.title}.**`,
		reward.kind && reward.kind !== "message" ? "Your private referral page shows your reward, or its preparation status." : reward.text,
		(!reward.kind || reward.kind === "message") && reward.url ? `[Get your reward](${reward.url})` : "",
		next
			? `${formatCount(next.referrals - count, "more referral")} ${next.referrals - count === 1 ? "unlocks" : "unlock"} ${next.title}. Your referral page has your link and everything you've unlocked: [open it](${pageUrl}).`
			: `That's every reward. Your referral page has your link and everything you've unlocked: [open it](${pageUrl}).`,
	];
	return {
		format: "markdown",
		subject: `You unlocked a reward from ${newsletter.name}`,
		previewText: `${reward.title}: thank you for sharing ${newsletter.name}.`,
		markdown: lines.filter(Boolean).join("\n\n"),
	};
}
