import { redirect } from "next/navigation";
import { hasActiveSubscription } from "@/lib/account-state";
import { requireAccount } from "@/lib/auth";
import { syncCheckoutReturn } from "@/lib/billing-provider";
import { isCloud } from "@/lib/config";
import { siteExtensions } from "@/lib/site-extensions";
import Account from "@/models/Account";

// Checkout's success URL. The webhook may not have arrived yet, so the checkout is read here too.
export async function GET(request) {
	const { account } = await requireAccount();
	if (!isCloud()) redirect("/billing");
	try {
		await syncCheckoutReturn({ account, params: new URL(request.url).searchParams });
	} catch (error) {
		console.error("[billing] Couldn't read the checkout:", error.message);
	}
	const current = await Account.findById(account._id).lean();
	// The dedicated IP add-on's checkout comes back to the billing page, which says whether it's on yet.
	if (new URL(request.url).searchParams.get("addon") === "dedicated_ip") redirect("/billing?addon=dedicated_ip");
	if (hasActiveSubscription(current)) await siteExtensions.sendGoalOnNextPage("plan_started");
	redirect(hasActiveSubscription(current) ? "/" : "/billing?checkout=pending");
}
