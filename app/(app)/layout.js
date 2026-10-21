import { redirect } from "next/navigation";
import LayoutDashboard from "@/components/LayoutDashboard";
import { isAdmin, requireAccount } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { WEB_APP_METADATA } from "@/lib/web-app";

// The dashboard installs as an app.
export const metadata = WEB_APP_METADATA;

// Opens for every account: each has a plan, the Free plan at least, whose limits the actions check. Billing lives in
// (account), outside this check.
export default async function AppLayout({ children }) {
	const { user, account } = await requireAccount();
	// The newsletters the pages and the newsletter menu read from this request's cache, so the check below asks no more.
	const { newsletters } = await getSelectedNewsletter();
	if (await needsOnboarding(account, newsletters)) redirect("/welcome");

	return (
		<LayoutDashboard user={user} account={account} isAdmin={isAdmin(user)}>
			{children}
		</LayoutDashboard>
	);
}
