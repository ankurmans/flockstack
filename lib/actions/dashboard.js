import "server-only";
import { ERROR_CODES } from "@/lib/account-state";
import { toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { requireAccount } from "@/lib/auth";
import { getBillingProvider } from "@/lib/billing-provider";

const UPGRADE_CODES = new Set(Object.values(ERROR_CODES));

// Every dashboard server action goes through here, so the dashboard runs exactly what an API key runs.
// An account without a plan runs only the actions marked tryWithoutPlan; the others fail with
// subscription_required, which opens the paywall. Failures come back as { failure: { code, message } }: a
// thrown error would replace the page with the error boundary.
export async function runDashboardAction(name, input) {
	const { user, account } = await requireAccount();
	try {
		return { output: await runAction(name, { account, user, input, via: "dashboard" }) };
	} catch (error) {
		return { failure: toActionError(error) };
	}
}

// What toasts show. Plan and account codes stay, so the toast can link to billing.
export function toFormError({ code, message }) {
	return { error: message, ...(UPGRADE_CODES.has(code) && { code }) };
}

// Billing's failures go back to the billing page, which says what happened from ?error=: the provider that couldn't be
// reached, or none while no provider is set up.
export function toBillingError({ code }) {
	if (code === "rate_limited") return "rate_limited";
	return getBillingProvider();
}
