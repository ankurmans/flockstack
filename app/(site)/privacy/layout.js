import { SiteAnalytics } from "@/components/SiteExtensions";

// One of FlockStack's own pages, so it carries the analytics. The directory readers use (recommendations) sits in the
// same group and doesn't: app/(site)/layout.js has none.
export default function PrivacyLayout({ children }) {
	return (
		<>
			{children}
			{SiteAnalytics && <SiteAnalytics />}
		</>
	);
}
