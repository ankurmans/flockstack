import "server-only";
import { actionError } from "@/lib/actions/errors";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";

// Stripe diagnostics may echo a buyer's address. Public group forms get only a stable, private error.
export async function groupStripeCall(callback) {
	try { return await callback(); }
	catch (error) {
		if (error instanceof StripeError || ["TimeoutError", "AbortError"].includes(error?.name) || error instanceof TypeError && /fetch/i.test(error.message)) throw actionError("unavailable", "Stripe couldn't complete this request. Try again later.");
		throw error;
	}
}

export function groupStripeRequest(path, options) {
	return groupStripeCall(() => stripeRequest(path, options));
}
