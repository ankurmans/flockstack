import { FIRST_SEND } from "./config.js";
import { formatRate, judgeRates } from "./rate-levels.js";

// Every never-mailed contact goes at once when there are no more than the smallest slice.
export function getFirstSendSlice(neverMailed) {
	const slice = Math.min(FIRST_SEND.maxSlice, Math.max(FIRST_SEND.minSlice, Math.round(neverMailed * FIRST_SEND.share)));
	return neverMailed > slice ? slice : null;
}

// The slice's rates over its sent emails, at a campaign's levels (lib/rate-levels.js): { level, reason } or null.
// block: the account is blocked with reason. pause: the rest of the campaign waits for its owner.
export function getFirstSendProblem({ sent = 0, bounced = 0, complained = 0 }) {
	const judged = judgeRates({ sent, bounced, complained });
	if (!judged) return null;
	const rate = `${judged.metric} rate of ${formatRate(judged.rate)} (limit ${formatRate(judged.limit)})`;
	return { level: judged.level, reason: `The first ${sent} new contacts had a ${rate}` };
}
