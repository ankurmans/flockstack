import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { SUPPORT_EMAIL } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/pages";

export const metadata = getDocsPageMetadata("/docs/briefings-bot");

// What site owners see when FlockStack-Briefings shows up in their logs. The user agent the fetcher sends links here.
export default function BriefingsBotPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="The FlockStack-Briefings fetcher">
				FlockStack-Briefings is the program that reads web pages for briefings: a FlockStack feature where a newsletter owner describes a
				topic, and FlockStack finds the week&apos;s stories on it and writes an issue that links to each original page, kept as a draft or, if the owner turns that on, sent once its checks pass.
			</HeaderDocs>

			<Section title="How to recognize it" stagger={1}>
				<p>It sends this user agent on every request:</p>
				<BlockCode title="User agent" className="mt-4" code="FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)" />
				<p className="mt-4">
					In robots.txt it follows the group for <Code>FlockStack-Briefings</Code>, else the one for <Code>FlockStack</Code>, else the one
					for every agent (<Code>*</Code>). It sends no cookies and logs in nowhere, and it never presents itself as a browser or as another
					program.
				</p>
			</Section>

			<Section title="What it reads" stagger={2}>
				<p>
					Pages that a FlockStack user&apos;s briefing found: a result of a search for the briefing&apos;s topic, a story in a feed the
					briefing reads, or a page linked from one of those. It does not crawl a site, follow its links beyond one step, or keep a copy of
					a page after the briefing&apos;s run: it keeps the facts it needs for a short summary, at most 25 words of quotation, and the
					link to the page.
				</p>
				<p className="mt-4">
					It also opens the pages a FlockStack issue links to when its writer checks the issue before sending it: it looks for the
					issue&apos;s figures on the pages it cites and checks that its links load, at most 25 links and 12 pages per check, and keeps
					nothing of the pages it read. When the owner has let the briefing send by itself, the same check runs on the issue just before it would go out, and a failing one keeps it as a draft.
				</p>
				<p className="mt-4">
					It reads at most 1 MB of a page, waits at most 8 seconds, makes at most 2 requests to one host at a time and at most 300
					requests in one run, and only to public addresses over https.
				</p>
			</Section>

			<Section title="What it never does" stagger={3}>
				<p>
					It never works around a paywall, a login or a block: no other user agents, no cookies, no headless browser, no rotating
					proxies, no cached or archived copies. A page that answers 401, 403 or 429 is not asked again another way, and a page behind a
					paywall is not used beyond what it shows to everyone.
				</p>
			</Section>

			<Section title="How to opt out" stagger={4}>
				<p>Disallow it in your robots.txt. The fetcher reads the file before its first request to a host and keeps what it read for up to 24 hours.</p>
				<BlockCode title="robots.txt" className="mt-4" code={"User-agent: FlockStack-Briefings\nDisallow: /"} />
				<p className="mt-4">
					A narrower rule, such as <Code>Disallow: /members/</Code>, keeps it out of those paths only. When robots.txt can&apos;t be read
					(a server error or no answer), the fetcher stays away from the host for an hour. A newsletter owner can also block a host for
					their own briefing.
				</p>
			</Section>

			<Section title="Contact" stagger={5}>
				<p>
					For a question or a problem with the fetcher, write to <a href={`mailto:${SUPPORT_EMAIL}`} className="text-link hover:underline">{SUPPORT_EMAIL}</a>{" "}
					with the address it requested and the time, and we will look into it.
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
