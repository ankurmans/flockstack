import { redirect } from "next/navigation";
import LayoutDashboard from "@/components/LayoutDashboard";
import { isAdmin, requireAccount } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";

// Opens for every account: each has a plan, the Free plan at least, whose limits the actions check. Billing lives in
// (account), outside this check.
export default async function AppLayout({ children }) {
	const { user, account } = await requireAccount();
	if (await needsOnboarding(account)) redirect("/welcome");

	return (
		<LayoutDashboard user={user} account={account} isAdmin={isAdmin(user)}>
			{children}
		</LayoutDashboard>
	);
}
