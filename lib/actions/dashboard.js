import "server-only";
import { ERROR_CODES } from "@/lib/account-state";
import { toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { requireAccount, requirePersonalAccount } from "@/lib/auth";
import { getBillingProvider } from "@/lib/billing-provider";
import { MIN_PRICE_CENTS } from "@/lib/payments/config";
import { toProductSlug } from "@/lib/product-slug";

// Billing is a person's own account page, including while their newsletter workspace belongs to a team.
const PERSONAL_BILLING = new Set(["get_billing", "change_plan", "set_extra_emails_limit", "add_dedicated_ip", "set_sent_with_link", "open_billing_portal"]);
const UPGRADE_CODES = new Set(Object.values(ERROR_CODES));

// Every dashboard server action goes through here, so the dashboard runs exactly what an API key runs. Failures come back
// as { failure: { code, message } }: a thrown error would replace the page with the error boundary.
export async function runDashboardAction(name, input) {
	const { user, account } = await (PERSONAL_BILLING.has(name) ? requirePersonalAccount() : requireAccount());
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

// A product's page address typed in its form, as the actions take it: "Bird Stickers Two" is bird-stickers-two, as the
// form shows it once the field is left. Empty when nothing was typed; null when what was typed has no letter or digit.
export function readProductSlug(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	return toProductSlug(text) || null;
}

// Billing's failures go back to the billing page, which says what happened from ?error=: the provider that couldn't be
// reached, or none while no provider is set up.
export function toBillingError({ code }) {
	if (code === "rate_limited") return "rate_limited";
	return getBillingProvider();
}
