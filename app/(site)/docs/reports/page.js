import Link from "next/link";
import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { MAX_REPORT_DAYS } from "@/lib/report-rules";
import { MAX_COMPARED } from "@/lib/reports";

export const metadata = getDocsPageMetadata("/docs/reports");

export default function ReportsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Reports">
				How your newsletter grew and where its readers came from, issues side by side, and what happens on your website, each as a table you can
				download as CSV.
			</HeaderDocs>

			<Section title="Overview" stagger={1}><p>The overview compares a selected range with the same number of days before it. Choose 30, 90, 180, 365 or 730 days on the dashboard; get_overview accepts 1 to 730. Subscriber history is reconstructed from retained join and leave dates, so imported history may be incomplete. Hourly sends remain today and yesterday, and plan usage remains the current billing month.</p></Section>

			<Section title="Growth" stagger={2}>
				<p>
					The{" "}
					<Link href="/reports" className="font-medium text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Reports page
					</Link>{" "}
					(or <Code>get_growth_report</Code>) shows who joined and left in each day, week or month of a range of up to {MAX_REPORT_DAYS} days (2 years),
					with the total at the end of each. A subscriber joins on the day they signed up, unless they are still waiting to confirm; they leave on the
					day they unsubscribed, bounced or complained. Imports leave out of the leavers, since their dates aren&apos;t yours. The total is worked back from
					today&apos;s subscribers. Days are UTC. Every number is one count the database makes, so a long range of a big list costs the same as a short one of a small
					one.
				</p>
				<p className="mt-4">
					The joins are split by <strong className="font-medium text-foreground">source</strong> (the website, a pop-up, a gated issue, a form, a Magic Link,
					the API, a recommendation), <strong className="font-medium text-foreground">channel</strong> (direct, search, social, email, paid, another website, a
					recommendation, the referral program), <strong className="font-medium text-foreground">UTM campaign</strong> or{" "}
					<strong className="font-medium text-foreground">form</strong>, with how many of each are still subscribed. The biggest 8 show; the rest are Other.
					Signups from before FlockStack kept where they came from have the channel their source says and no campaign.
				</p>
			</Section>

			<Section title="Issues side by side" stagger={2}>
				<p>
					<Code>compare_issues</Code> lists your newest sent issues (up to {MAX_COMPARED}, or the ones you pick with <Code>ids</Code>, or a date range) with what
					went out, opens, clicks and unsubscribes with their rates, bounces, complaints, views of the issue&apos;s web page and its most clicked link. Rates are of
					delivered emails. It reads each issue&apos;s own counters, so it doesn&apos;t grow with the list.
				</p>
			</Section>

			<Section title="Your website" stagger={3}>
				<p>
					Page views and visitors for each day of the last year, the websites that sent them, their countries, desktop, mobile and tablet views and the issues read most
					(<Code>get_site_report</Code>). It is counted by FlockStack as pages open: no cookie, no browser storage and no script from another company, and
					nothing is kept about a visitor. A visitor is a hash of their network address and browser that changes every day and is never stored. It only decides
					which of a few hundred counters for that day goes up, so you see an estimate of distinct visitors for each day, within a few percent, and nobody can see who
					they were. Someone back tomorrow is a new visitor, so the total is the days&apos; visitors added up. The country is what Cloudflare reports for the visitor&apos;s
					network, and the kind of device is read from the browser as the page opens: only desktop, mobile or tablet is counted, never the browser&apos;s name. A browser that sends Do Not Track or Global Privacy Control, and a crawler, isn&apos;t counted. Newsletters don&apos;t get third-party tracking
					pixels: a reader&apos;s browser talks only to your newsletter&apos;s host.
				</p>
			</Section>

			<Section title="CSV" stagger={4}>
				<p>
					Every report has its export buttons, and <Code>export_report</Code> does the same from the API: <Code>report</Code> growth (a <Code>series</Code> table, one row
					for each period, or a <Code>breakdown</Code>, one row for each group with a column for each period), issues, or site (<Code>daily</Code>,{" "}
					<Code>referrers</Code>, <Code>devices</Code>, <Code>countries</Code> or <Code>pages</Code>). Rates are fractions from 0 to 1, and a cell a spreadsheet would run as a formula is
					quoted as text.
				</p>
			</Section>
		</>
	);
}

function Section({ title, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="mt-12 max-w-3xl animate-enter first-of-type:mt-0">
			<h2 className="mb-3 text-xl font-semibold tracking-tight">{title}</h2>
			<div className="text-[15px] leading-7 text-pretty text-foreground/80">{children}</div>
		</section>
	);
}

function Code({ children }) {
	return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;
}
