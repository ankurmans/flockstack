import { isPaidContact } from "./tiers.js";

// Who may comment on which issue, and the reader's display name. Pure: the pages, the actions and the emails all ask here.
export const COMMENT_WHO = ["everyone", "paid"];
export const COMMENT_MODERATION = ["none", "hold_links", "hold_all"];
export const COMMENT_ISSUE_MODES = ["on", "off"];
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;
export const DELETED_READER = "Deleted reader";

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'’-]*$/u;
const DERIVED_NAME_MAX = 30;

// The newsletter's setting with its defaults: off, open to everyone subscribed, nothing held, the owner told.
export function getCommentSettings(newsletter) {
	const comments = newsletter?.comments ?? {};
	return {
		enabled: comments.enabled === true,
		who: COMMENT_WHO.includes(comments.who) ? comments.who : "everyone",
		moderation: COMMENT_MODERATION.includes(comments.moderation) ? comments.moderation : "none",
		notifyOwner: comments.notifyOwner !== false,
	};
}

// An issue's own word wins over the newsletter's. A paid-only issue has no page with its text, so nothing to discuss there.
export function areCommentsOn(newsletter, campaign) {
	if (campaign?.audience === "paid") return false;
	if (campaign?.comments === "on") return true;
	if (campaign?.comments === "off") return false;
	return getCommentSettings(newsletter).enabled;
}

// ana.lopez+news@example.com -> "Ana Lopez": the part before the @, without a +tag, separators as spaces. Never the domain.
export function deriveDisplayName(email) {
	const local = String(email ?? "").split("@")[0].split("+")[0];
	const words = local
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.map((word) => word.replace(/\d+$/, ""))
		.filter(Boolean);
	const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ").slice(0, DERIVED_NAME_MAX).trim();
	return name.length >= DISPLAY_NAME_MIN ? name : "Reader";
}

// { name } or { problem }. A name can't pass for the newsletter or its author, or carry an address or a link.
export function normalizeDisplayName(value, newsletter) {
	const name = String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
	if (name.length < DISPLAY_NAME_MIN || name.length > DISPLAY_NAME_MAX) {
		return { problem: `Use ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters for your name` };
	}
	if (!NAME_PATTERN.test(name)) return { problem: "Use letters, numbers, spaces and . _ ' - in your name" };
	const taken = [newsletter?.name, newsletter?.fromName].filter(Boolean).map((other) => other.trim().toLowerCase());
	if (taken.includes(name.toLowerCase())) return { problem: "That name belongs to the newsletter. Pick another." };
	return { name };
}

export const ACCESS_MESSAGES = {
	off: "Comments are off for this issue.",
	"not-subscribed": "Only subscribers can comment.",
	"paid-only": "Comments on this newsletter are for paid subscribers.",
};

// Whether a stored contact may comment on an issue now. { ok: true }, or { ok: false, code, message } with the words for
// the reader. A blocked reader gets the owner's reason.
export function getCommentAccess({ newsletter, campaign, contact, now = Date.now() }) {
	if (!areCommentsOn(newsletter, campaign)) return { ok: false, code: "off", message: ACCESS_MESSAGES.off };
	if (!contact || contact.status !== "active") return { ok: false, code: "not-subscribed", message: ACCESS_MESSAGES["not-subscribed"] };
	if (contact.community?.blocked) {
		const reason = contact.community.blockedReason;
		return { ok: false, code: "blocked", message: `Commenting is turned off for you${reason ? `: ${reason}` : "."}` };
	}
	if (getCommentSettings(newsletter).who === "paid" && !isPaidContact(contact, now)) {
		return { ok: false, code: "paid-only", message: ACCESS_MESSAGES["paid-only"] };
	}
	return { ok: true };
}
