import crypto from "node:crypto";

// A gift link opens one paid issue's web page for anyone holding it, in this browser only: the email, the comments, the audio
// and every other issue stay as they were. Pure, so the actions, the reader's button and the dashboard read the same limits.
export const GIFT_LINK_LIMITS = {
	opens: { min: 1, max: 100, default: 10 },
	days: { min: 1, max: 90, default: 30 },
	perReaderPerMonth: { min: 1, max: 20, default: 3 },
	note: 120,
};
export const GIFT_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const GIFT_LINK_STATES = ["active", "used_up", "expired", "revoked"];
// The browser that has already opened a link keeps its place for this long, whatever the link's own end.
export const GIFT_OPEN_COOKIE_DAYS = 90;
const DAY_MS = 86_400_000;

export function newGiftCode() {
	return crypto.randomBytes(16).toString("base64url");
}

// What the newsletter saved for readers' gift links, over the defaults. Off until the owner turns it on.
export function getGiftLinkSettings(newsletter) {
	const saved = newsletter?.giftLinks ?? {};
	const pick = (value, fallback) => (Number.isInteger(value) ? value : fallback);
	return {
		enabled: saved.enabled === true,
		perReaderPerMonth: pick(saved.perReaderPerMonth, GIFT_LINK_LIMITS.perReaderPerMonth.default),
		opensPerLink: pick(saved.opensPerLink, GIFT_LINK_LIMITS.opens.default),
		days: pick(saved.days, GIFT_LINK_LIMITS.days.default),
	};
}

export function getGiftLinkProblem({ perReaderPerMonth, opensPerLink, days }) {
	const { opens, days: dayLimits, perReaderPerMonth: perReader } = GIFT_LINK_LIMITS;
	const inRange = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max;
	if (!inRange(perReaderPerMonth, perReader)) return `perReaderPerMonth: a whole number from ${perReader.min} to ${perReader.max}`;
	if (!inRange(opensPerLink, opens)) return `opensPerLink: a whole number from ${opens.min} to ${opens.max}`;
	if (!inRange(days, dayLimits)) return `days: a whole number from ${dayLimits.min} to ${dayLimits.max}`;
	return null;
}

export function getGiftLinkExpiry(days, now = new Date()) {
	return new Date(now.getTime() + days * DAY_MS);
}

export function getGiftLinkState(link, now = new Date()) {
	if (link.revokedAt) return "revoked";
	if (new Date(link.expiresAt) <= now) return "expired";
	if ((link.opens ?? 0) >= link.maxOpens) return "used_up";
	return "active";
}

// The first moment of the UTC month, which a reader's allowance of links counts from.
export function getMonthStart(now = new Date()) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export const GIFT_REFUSALS = {
	revoked: "The person who shared this issue took the link back.",
	expired: "This gift link has expired.",
	used_up: "This gift link has been opened as many times as it allows.",
	unknown: "This gift link doesn't work.",
};
