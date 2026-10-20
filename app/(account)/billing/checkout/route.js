import { redirect } from "next/navigation";
import { isPaidStatus } from "@/lib/account-state";
import { runDashboardAction, toBillingError } from "@/lib/actions/dashboard";
import { getCurrentAccount } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { getPlan, readInterval } from "@/lib/plans";

// The plans slider's Subscribe link, on the public pages, the paywall and billing: Checkout for that plan. Accounts that
// already pay get the billing page, where a plan change is confirmed with the billing provider; one on Free, on a plan an
// admin gave or whose plan lapsed gets Checkout, which is how a first purchase works too. A plan that isn't on sale
// (change_plan's validation_failed), and Free, which has no checkout, get the billing page.
export async function GET(request) {
	const url = new URL(request.url);
	const plan = getPlan(url.searchParams.get("plan"));
	const interval = readInterval(url.searchParams.get("interval"));
	const current = await getCurrentAccount();
	if (!current) redirect(`/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
	if (!plan || !isCloud() || isPaidStatus(current.account.subscriptionStatus)) redirect(`/billing?interval=${interval}`);

	const { output, failure } = await runDashboardAction("change_plan", { plan: plan.id, interval });
	if (failure?.code === "validation_failed") redirect(`/billing?interval=${interval}`);
	redirect(failure ? `/billing?interval=${interval}&error=${toBillingError(failure)}` : output.url);
}
