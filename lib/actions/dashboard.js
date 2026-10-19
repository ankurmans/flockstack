import "server-only";
import { ERROR_CODES } from "@/lib/account-state";
import { toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { requireAccount } from "@/lib/auth";
import { getBillingProvider } from "@/lib/billing-provider";
import { MIN_PRICE_CENTS } from "@/lib/payments/config";

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

export const MIN_PRICE = MIN_PRICE_CENTS / 100;

// A price typed in a form ("19", "19.50", "19,50") in the currency's smallest unit, as the actions take it. NaN when it
// isn't one they take: the form says so in its own words, where the action's answer would name priceCents. Empty is 0
// where the field can be left empty.
export function readPriceCents(value, { allowEmpty = false } = {}) {
	const text = String(value ?? "").trim();
	if (!text && allowEmpty) return 0;
	const amount = Number(text.replace(",", "."));
	return Number.isFinite(amount) && amount * 100 >= MIN_PRICE_CENTS ? Math.round(amount * 100) : Number.NaN;
}

// Billing's failures go back to the billing page, which says what happened from ?error=: the provider that couldn't be
// reached, or none while no provider is set up.
export function toBillingError({ code }) {
	if (code === "rate_limited") return "rate_limited";
	return getBillingProvider();
}
