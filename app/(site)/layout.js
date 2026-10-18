import FooterSite from "@/components/FooterSite";
import HeaderSite from "@/components/HeaderSite";
import { SiteBand } from "@/components/SiteExtensions";
import { getAppUrl, isCloud } from "@/lib/config";
import { newsreader } from "@/lib/fonts";
import { SITE_OPEN_GRAPH } from "@/lib/site";
import { siteExtensions } from "@/lib/site-extensions";
import { cn } from "@/lib/utils";

const TWITTER_CREATOR = isCloud() ? siteExtensions.twitterCreator : null;

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
// The docs and the landing page show the app's address, which is each region's own.
export const dynamic = "force-dynamic";

export const metadata = {
	metadataBase: new URL(getAppUrl()),
	robots: { index: true, follow: true },
	manifest: "/site.webmanifest",
	openGraph: SITE_OPEN_GRAPH,
	twitter: { card: "summary_large_image", ...(TWITTER_CREATOR && { creator: TWITTER_CREATOR }) },
};

// The docs need a wider page than the rest; the header and footer follow whichever page is open. The analytics
// (SiteAnalytics) is not here: this layout also holds the directory readers use (recommendations), so each of
// FlockStack's own pages gets it from the layout of its folder.
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
