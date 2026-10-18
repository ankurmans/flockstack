import { Suspense } from "react";
import { SiteAnalytics, SupportChat } from "@/components/SiteExtensions";

// One of FlockStack's own pages, so it carries the analytics and the help chat. The directory readers use
// (recommendations) sits in the same group and doesn't: app/(site)/layout.js has neither.
export default function PrivacyLayout({ children }) {
	return (
		<>
			{children}
			{SupportChat && (
				<Suspense fallback={null}>
					<SupportChat />
				</Suspense>
			)}
			{SiteAnalytics && <SiteAnalytics />}
		</>
	);
}
