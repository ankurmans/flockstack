import FooterSite from "@/components/FooterSite";
import HeaderSite from "@/components/HeaderSite";
import { SiteBand } from "@/components/SiteExtensions";
import { isCloud } from "@/lib/config";
import { newsreader } from "@/lib/fonts";
import { SITE_OPEN_GRAPH } from "@/lib/site";
import { getSiteOrigin } from "@/lib/site-origin";
import { siteExtensions } from "@/lib/site-extensions";
import { cn } from "@/lib/utils";

const TWITTER_CREATOR = isCloud() ? siteExtensions.twitterCreator : null;

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
// The docs show the app's address, which is each region's own.
export const dynamic = "force-dynamic";

// Pages' canonical paths, their social cards and their address resolve against the address the pages are indexed at:
// on FlockStack Cloud's EU Worker that's the US one, which serves the same pages (lib/site-origin.js).
export function generateMetadata() {
	return {
		metadataBase: new URL(getSiteOrigin()),
		robots: { index: true, follow: true },
		manifest: "/site.webmanifest",
		openGraph: SITE_OPEN_GRAPH,
		twitter: { card: "summary_large_image", ...(TWITTER_CREATOR && { creator: TWITTER_CREATOR }) },
	};
}

// The docs need a wider page than the rest; the header and footer follow whichever page is open. The analytics
// (SiteAnalytics) and the help chat (SupportChat) are not here: this layout also holds the directory readers use
// (recommendations), so each of FlockStack's own pages gets them from the layout of its folder.
export default function SiteLayout({ children }) {
	return (
		<div
			className={cn(
				newsreader.variable,
				"flex min-h-dvh flex-col bg-site [--site-width:72rem] has-[[data-layout=docs]]:[--site-width:80rem]"
			)}
		>
			<HeaderSite />
			<div className="flex-1">{children}</div>
			{isCloud() && SiteBand && <SiteBand />}
			<FooterSite />
		</div>
	);
}
