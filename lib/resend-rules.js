// A resend (resend_campaign, lib/resends.js): a copy of a sent campaign with a subject of its own, for the readers its
// first send reached who didn't open it, or didn't click. One per campaign, 24 hours after it by default.
export const RESEND_TARGETS = ["unopened", "unclicked"];
export const RESEND_DELAY_HOURS = 24;

export function isResend(campaign) {
	return Boolean(campaign?.resend?.of);
}
