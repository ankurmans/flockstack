import { redirect } from "next/navigation";
import CardRedirects from "@/components/CardRedirects";
import CardSearch from "@/components/CardSearch";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { scoped } from "@/lib/account-scope";
import { getWelcomePauseNotice } from "@/lib/account-state";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { hasPublishedIssue } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { cleanupTotalsPipeline } from "@/lib/cleanup";
import { getAppUrl, getArchiveCnameTarget, getSharedDomain, isSendingEnabled } from "@/lib/config";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { formatJsonLd } from "@/lib/seo-rules";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";
import { siteExtensions } from "@/lib/site-extensions";
import { getUsage } from "@/lib/usage";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Settings" };

// The open newsletter's settings; /newsletters/<id> opens another one first. The form starts over for each
// newsletter: its fields keep what they were given when it first rendered.
export default async function SettingsPage() {
	const { user, account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const [newsletter, domains, cleanupTotals, usage, hasSentIssue, { output: redirects }] = await Promise.all([
		Newsletter.findOne(scoped(account, { _id: selected._id })).lean(),
		findAccountDomains(account._id),
		getCleanupTotals(account, selected._id),
		getUsage(account),
		hasPublishedIssue({ accountId: account._id, _id: selected._id }),
		runDashboardAction("list_redirects", { newsletter: String(selected._id) }),
	]);

	return (
		<LayoutNarrow>
			<HeaderPage title="Settings" />
			<FormNewsletter
				key={String(newsletter._id)}
				newsletter={serialize(newsletter)}
				domains={serialize(domains)}
				sharedDomain={getSharedDomain()}
				appUrl={getAppUrl()}
				hasArchiveHost={Boolean(getArchiveCnameTarget())}
				hasSentIssue={hasSentIssue}
				defaultPostalAddress={siteExtensions.defaultPostalAddress}
				isSendingEnabled={isSendingEnabled()}
				testEmail={user.email}
				cleanupTotals={cleanupTotals}
				welcomePause={usage.welcomeEmailsPaused ? getWelcomePauseNotice(usage) : null}
			/>
			<CardSearch
				key={`search-${newsletter._id}`}
				newsletterId={String(newsletter._id)}
				urls={newsletter.archiveEnabled ? (({ sitemap, robots, llms, feed }) => ({ sitemap, robots, llms, feed }))(getArchiveUrls(newsletter)) : null}
				jsonLd={formatJsonLd(newsletter.jsonLd)}
				className="mt-4"
			/>
			<CardRedirects key={`redirects-${newsletter._id}`} newsletterId={String(newsletter._id)} initial={redirects ?? null} className="mt-4" />
		</LayoutNarrow>
	);
}

async function getCleanupTotals(account, newsletterId) {
	const [totals] = await Contact.aggregate(cleanupTotalsPipeline({ accountId: account._id, newsletterId }));
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
