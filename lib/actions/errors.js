import { ERROR_CODES } from "../account-state.js";

// Stable codes: scripts and agents branch on them, so a code never changes meaning. The REST API answers
// with the status next to each code, MCP with the same { code, message } in an error result.
export const ERRORS = {
	unauthorized: { status: 401, description: "The API key is missing, malformed, unknown or revoked." },
	forbidden: { status: 403, description: "The key's level doesn't allow this action (a signups only key can only add contacts; a read only key can only read), or the key is limited to one newsletter and the action reaches another newsletter or the whole account." },
	not_found: { status: 404, description: "The newsletter, campaign, contact, domain or key isn't in this account." },
	validation_failed: { status: 400, description: "The input doesn't match the schema or breaks a rule. The message names the field." },
	conflict: {
		status: 409,
		description: "The resource's state doesn't allow it, e.g. sending a campaign that is already sending or sent. Retrying won't help.",
	},
	rate_limited: {
		status: 429,
		description: "Too many requests with this key, or too many of one action for the account, whose keys, apps and dashboard share its limits. Wait and retry.",
	},
	daily_cap_reached: {
		status: 429,
		description: "The key reached the daily request cap its owner set. The count starts over at midnight UTC; the owner can raise the cap on the API keys page.",
	},
	ai_daily_limit: {
		status: 429,
		description: "The account used all the shared AI requests its plan gives it for today (get_ai_usage has the numbers). The count starts over at midnight UTC.",
	},
	[ERROR_CODES.subscriptionRequired]: { status: 402, description: "The account can't send: it is waiting to be deleted. Every other account has a plan, the Free plan at least." },
	billing_off: {
		status: 404,
		description: "The server is self-hosted without billing: every account has every feature, without plan limits.",
	},
	[ERROR_CODES.planLimitEmails]: {
		status: 402,
		description: "The send needs more emails than the plan has left this month, extra emails included, or goes to more people than a Free account's first campaigns may. The message has the numbers; nothing is cut.",
	},
	[ERROR_CODES.planLimitSubscribers]: { status: 402, description: "The account has more active subscribers than its plan allows." },
	[ERROR_CODES.accountBlocked]: {
		status: 403,
		description:
			"The account is blocked after spam signals (bounce or complaint rates, Gmail's spam rate in Google Postmaster Tools, a spam trap, the email provider) or by an admin. Nothing is sent, the tracked links in its emails stop redirecting, and only reads, pausing, unscheduling, revoking access and billing work until an admin unblocks it.",
	},
	payments_not_ready: {
		status: 409,
		description: "Payments can't take a sale yet: the account has no connected Stripe account that can take charges (FlockStack Cloud), or the server has no Stripe key (self-hosted). get_payments_status says what is missing.",
	},
	sender_not_allowed: {
		status: 422,
		description: "The from address is neither the newsletter's shared address nor on a verified domain of this account.",
	},
	send_check_failed: {
		status: 422,
		description: "A pre-send check failed: no postal address, subject or content, or the email is over 100 KB.",
	},
	audio_quota_exceeded: {
		status: 402,
		description: "The audio version needs more characters than the plan has left this month, or the plan has no audio. The message says how many are left; the count starts over on the 1st. There is no overage.",
	},
	no_recipients: { status: 422, description: "Nobody is left to send to." },
	newsletter_paused: { status: 409, description: "This newsletter reached its bounce or complaint pause level. Check its list and resume once its 7-day rates are under the limits. Account-wide safeguards still apply." },
	sending_disabled: { status: 503, description: "Sending is turned off on this server." },
	unavailable: { status: 503, description: "A service the action needs isn't configured or didn't answer. Retry later." },
	internal_error: { status: 500, description: "Something failed on FlockStack's side." },
};

export function actionError(code, message) {
	return Object.assign(new Error(message), { code, isActionError: true });
}

export function getErrorStatus(code) {
	return ERRORS[code]?.status ?? 500;
}

// Library errors that carry one of the codes above keep it; anything else is an internal error.
export function toActionError(error) {
	if (Object.hasOwn(ERRORS, error?.code ?? "")) return { code: error.code, message: error.message };
	return { code: "internal_error", message: "Something went wrong, try again in a minute" };
}

export function formatIssues(issues) {
	return issues
		.slice(0, 3)
		.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message))
		.join("; ");
}
