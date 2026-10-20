import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getAppUrl } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/llms";

export const metadata = getDocsPageMetadata("/docs/rss");

export default function RssPage() {
	const appUrl = getAppUrl();

	return (
		<>
			<HeaderDocs kicker="Guides" title="RSS feed">
				Every newsletter with a website has an RSS feed with the full text of its issues. Readers follow it in any feed app, without an
				email address, and it works as a way to move your archive somewhere else.
			</HeaderDocs>

			<Section title="Where it is" stagger={1}>
				<p>
					The feed is <Code>/feed.xml</Code> on the newsletter&apos;s website: <Code>https://your-slug.example.com/feed.xml</Code>, on its own
					subdomain once you&apos;ve added a domain. Without a shared domain, as on a self-hosted server, it is{" "}
					<Code>{appUrl}/archive/your-slug/feed</Code>. The website links to it in its footer and in the head of every page, so feed apps find
					it from the website&apos;s address alone.
				</p>
				<BlockCode
					title="In every page's head"
					className="mt-4"
					code={`<link rel="alternate" type="application/rss+xml" title="Your newsletter" href="https://your-slug.example.com/feed.xml">`}
				/>
			</Section>

			<Section title="What it contains" stagger={2}>
				<p>
					The 30 latest issues, newest first, as RSS 2.0. Each item has the subject, the issue&apos;s address on the website, the date it
					went out, the author, a short description and the whole issue as HTML in <Code>content:encoded</Code>. Each item&apos;s{" "}
					<Code>guid</Code> is the issue&apos;s ID, so it stays the same when the website moves to your own domain.
				</p>
				<p className="mt-4">
					Issues you unlist from the website (the campaign&apos;s archive setting) are not in the feed, and neither are issues that aren&apos;t
					free. Drafts and unsent issues never are. A website that is off, or that has no issue yet, has no feed.
				</p>
			</Section>

			<Section title="Caching" stagger={3}>
				<p>
					Feed apps check often, so the feed answers <Code>ETag</Code> and <Code>Last-Modified</Code>, and a repeat request with{" "}
					<Code>If-None-Match</Code> gets <Code>304 Not Modified</Code> without the body. It allows caches to keep the file for 15 minutes.
					A new issue shows up in the feed within that time.
				</p>
			</Section>

			<Section title="Putting someone else's feed in an issue" stagger={4}>
				<p>
					The editor&apos;s <Code>/RSS feed</Code> block shows the latest items of any RSS or Atom feed: a link, a date, an excerpt and a
					picture for each, as many as you choose (up to 10), newest or oldest first. The feed is read when the issue goes out: the block
					becomes the items themselves in the saved issue, so every reader and the issue&apos;s page show the same ones. A test email reads
					the feed too, and a feed that can&apos;t be read stops the send before it starts.
				</p>
				<p className="mt-4">
					Feeds are read over https only, from public addresses, up to 1 MB and 8 seconds, and FlockStack keeps what it read for 5 minutes.
					From the API, put <Code>{`<div data-rss="https://example.com/feed.xml" data-count="3"></div>`}</Code> in a rich campaign, and
					check a feed with <Code>preview_feed</Code>.
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
