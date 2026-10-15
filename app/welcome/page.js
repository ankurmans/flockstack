import { Suspense } from "react";
import { redirect } from "next/navigation";
import FormOnboarding from "@/components/FormOnboarding";
import { SiteAnalytics, SupportChat } from "@/components/SiteExtensions";
import { requireAccount } from "@/lib/auth";
import { LIST_SIZES, LIST_SOURCES, OTHER_LIST_SOURCE, needsOnboarding } from "@/lib/onboarding";

export const metadata = { title: "Set up your newsletter" };

// Where the dashboard sends an account without a newsletter (app/(app)/layout.js).
export default async function WelcomePage() {
	const { user, account } = await requireAccount();
	if (!(await needsOnboarding(account))) redirect("/");
	const name = String(user.name ?? "").trim();

	return (
		<>
			<FormOnboarding
				defaultFromName={name.includes("@") ? "" : name}
				image={user.image || null}
				listSizes={LIST_SIZES}
				listSources={LIST_SOURCES}
				otherListSource={OTHER_LIST_SOURCE}
			/>
			{SupportChat && (
				<Suspense fallback={null}>
					<SupportChat user={user} account={account} />
				</Suspense>
			)}
			{SiteAnalytics && <SiteAnalytics goal="onboarding_started" />}
		</>
	);
}
