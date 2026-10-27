export const MAX_REWARDS = 10;
export const MAX_REWARD_REFERRALS = 10_000;
export const MAX_REWARD_TITLE = 100;
export const MAX_REWARD_TEXT = 1000;
export const MAX_REWARD_URL = 500;
const REWARD_URL_PATTERN = /^https:\/\/[^\s"'<>]{4,}$/i;

function newRewardId() {
	return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// What a referral needs from the newsletter to count: a website with the signup form that the links lead to, and confirmed
// opt-in, so a referral only counts once the new subscriber has proved their address.
export function getReferralSetupProblem(newsletter) {
	if (!newsletter?.requireConfirmation) return "Turn on confirmation emails first: a referral counts once the new subscriber confirms.";
	if (!newsletter.archiveEnabled) return "Turn on the website first: referral links lead to its signup form.";
	return null;
}

export function isReferralActive(newsletter) {
	return Boolean(newsletter?.referral?.enabled) && getReferralSetupProblem(newsletter) === null;
}

export function sortRewards(rewards = []) {
	return [...rewards].sort((a, b) => a.referrals - b.referrals);
}

// The first reward still out of reach, or null.
export function getNextReward(rewards, count) {
	return sortRewards(rewards).find((reward) => reward.referrals > count) ?? null;
}

export function getUnlockedRewards(rewards, count) {
	return sortRewards(rewards).filter((reward) => reward.referrals <= count);
}

// The rewards as saved: each with an ID (kept when it has one), trimmed text and the lowest count first. Answers the
// problem in words, or the rewards.
export function normalizeRewards(rewards) {
	if (rewards.length > MAX_REWARDS) return { problem: `Add at most ${MAX_REWARDS} rewards` };
	const seen = new Set();
	const ids = new Set();
	const normalized = [];
	for (const [index, reward] of rewards.entries()) {
		const label = `Reward ${index + 1}`;
		const title = String(reward.title ?? "").trim();
		const url = String(reward.url ?? "").trim();
		const text = String(reward.text ?? "").trim();
		if (!Number.isInteger(reward.referrals) || reward.referrals < 1 || reward.referrals > MAX_REWARD_REFERRALS) {
			return { problem: `${label}: referrals should be a whole number from 1 to ${MAX_REWARD_REFERRALS}` };
		}
		if (seen.has(reward.referrals)) return { problem: `${label}: another reward already unlocks at ${reward.referrals} referrals` };
		seen.add(reward.referrals);
		if (!title) return { problem: `${label}: add a title` };
		if (title.length > MAX_REWARD_TITLE) return { problem: `${label}: keep the title under ${MAX_REWARD_TITLE} characters` };
		const kind = reward.kind ?? "message";
		if (!["message", "code", "gift"].includes(kind)) return { problem: `${label}: choose a message, unique code or gifted months` };
		if (kind === "gift" && (!Number.isInteger(reward.months) || reward.months < 1 || reward.months > 12 || !/^[A-Za-z0-9_-]{1,80}$/.test(reward.tierId ?? ""))) return { problem: `${label}: choose a paid tier and 1 to 12 months` };
		if (kind === "message" && !url && !text) return { problem: `${label}: add a link or a message to reveal` };
		if (url && (url.length > MAX_REWARD_URL || !REWARD_URL_PATTERN.test(url))) return { problem: `${label}: the link must start with https://` };
		if (text.length > MAX_REWARD_TEXT) return { problem: `${label}: keep the message under ${MAX_REWARD_TEXT} characters` };
		const id = /^[a-f0-9]{12}$/.test(reward.id ?? "") ? reward.id : newRewardId();
		if (ids.has(id)) return { problem: `${label}: each reward needs its own ID` };
		ids.add(id);
		normalized.push({ id, referrals: reward.referrals, title, url, text, ...(kind !== "message" && { kind }), ...(kind === "gift" && { tierId: reward.tierId, months: reward.months }) });
	}
	return { rewards: sortRewards(normalized) };
}
