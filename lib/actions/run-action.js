import "server-only";
import { ERROR_CODES, getBlockedMessage, hasActiveSubscription, isBlocked, isDeletionPending } from "@/lib/account-state";
import { ERRORS, actionError, formatIssues } from "@/lib/actions/errors";
import { getAction } from "@/lib/actions/registry";
import { describeAgent, guardCall, rejectDisallowed } from "@/lib/agent-guard";
import { connectDb } from "@/lib/db";
import { formatWindow } from "@/lib/format";
import { isRateLimited } from "@/lib/rate-limit";
import { getSupportChatUrl } from "@/lib/support";

// Each API key and connected app counts on its own and against its account, which the dashboard's calls count
// against too (limitDashboard): an account gets an action's limit once, however many keys and apps it has.
function getRateLimits({ action, account, input, via, apiKey, connection }) {
	if (!action.rateLimit) return {};
	const perAccount = { name: `account-${action.name}`, ...action.rateLimit, key: String(account._id) };
	const caller = apiKey ? String(apiKey._id) : connection && `oauth-${connection.id}`;
	if (caller) return { perCaller: { name: `api-${action.name}`, ...action.rateLimit, key: caller }, perAccount };
	if (via !== "dashboard") return {};
	const { limitDashboard } = action;
	const counts = typeof limitDashboard === "function" ? limitDashboard(input ?? {}) : limitDashboard;
	return counts ? { perAccount } : {};
}

// "Send a test email" -> "You can send a test email 30 times an hour. Try again later."
function getDashboardLimitMessage({ title, rateLimit }) {
	const times = rateLimit.limit === 1 ? "once" : `${rateLimit.limit} times`;
	return `You can ${title[0].toLowerCase()}${title.slice(1)} ${times} ${formatWindow(rateLimit.window)}. Try again later.`;
}

// The one way in for the dashboard (via "dashboard", a signed-in user), the REST API ("api") and MCP
// ("mcp"), with an API key or, on MCP, an app connected with OAuth (connection, full access, with its user).
// Same permission, plan, rate limit and input checks for all of them. Throws errors with a code from
// lib/actions/errors.js. A key or an app also meets lib/agent-guard.js: its level, its newsletter, its cap and the owner's
// approval, which answers { status: "approval_required" } in place of the result (isApprovalRequired). requestId: the
// caller's request, for the activity log. approvalId: an action the owner approved, run as the key or app that asked.
export async function runAction(name, { account, input = {}, via, user = null, apiKey = null, connection = null, requestId = null, approvalId = null }) {
	const action = getAction(name);
	if (!action) throw actionError("not_found", `There's no ${name} action`);
	if (action.dashboardOnly && via !== "dashboard") throw actionError("forbidden", `${name} can only be done by a person in the dashboard`);
	if (isDeletionPending(account)) throw actionError("unauthorized", "This account is being deleted");
	const agent = describeAgent({ apiKey, connection });
	if (agent) await rejectDisallowed({ account, agent, action, input: input ?? {}, via, requestId });
	if (isBlocked(account) && !action.whileBlocked) {
		throw actionError(ERROR_CODES.accountBlocked, getBlockedMessage(account, via === "dashboard" ? null : getSupportChatUrl()));
	}
	const isTrial = via === "dashboard" && action.tryWithoutPlan;
	if (action.requiresPlan && !isTrial && !hasActiveSubscription(account)) {
		throw actionError(ERROR_CODES.subscriptionRequired, "This account is being deleted");
	}
	const { perCaller, perAccount } = getRateLimits({ action, account, input, via, apiKey, connection });
	if (perCaller && (await isRateLimited(perCaller))) throw actionError("rate_limited", `Too many ${name} calls, try again later`);
	if (perAccount && (await isRateLimited(perAccount))) {
		throw actionError("rate_limited", via === "dashboard" ? getDashboardLimitMessage(action) : `Too many ${name} calls on this account, try again later`);
	}
	const schema = via === "dashboard" && action.dashboardInput ? action.input.extend(action.dashboardInput.shape) : action.input;
	const parsed = schema.safeParse(input ?? {});
	if (!parsed.success) throw actionError("validation_failed", formatIssues(parsed.error.issues));

	await connectDb();
	const guarded = agent ? await guardCall({ account, agent, action, input: parsed.data, via, requestId, isApproved: Boolean(approvalId) }) : null;
	if (guarded?.response) return guarded.response;
	try {
		const output = await action.handler({ account, input: guarded?.input ?? parsed.data, via, user, apiKey, connection });
		return guarded ? await guarded.finish(output) : output;
	} catch (error) {
		if (!Object.hasOwn(ERRORS, error?.code ?? "")) console.error(`[actions] ${name} failed: ${describeFailure(error)}`, error);
		if (guarded) await guarded.finish(null, error);
		throw error;
	}
}

// Workers logs show only an error's stack, and an AWS error can have no message: say what it is, in one line.
function describeFailure(error) {
	const meta = error?.$metadata;
	return [
		error?.name,
		error?.message,
		error?.Code && `code ${error.Code}`,
		meta?.httpStatusCode && `HTTP ${meta.httpStatusCode}`,
		meta?.attempts && `${meta.attempts} attempts`,
		error?.cause && `cause: ${error.cause?.message ?? error.cause}`,
	]
		.filter(Boolean)
		.join(" | ");
}
